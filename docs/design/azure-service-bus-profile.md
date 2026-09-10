---
title: "Proposed Azure Service Bus profile"
description: "RFC for a closed, versioned AsyncAPI 3.1.0 Service Bus contract profile, without a runtime or provisioning API."
---

# Azure Service Bus contract profile

**Status: reviewed for initial implementation, 2026-09-10.** This is the design deliverable for [#5](https://github.com/cataggar/tsp-asyncapi/issues/5). Independent automated design review of [#7](https://github.com/cataggar/tsp-asyncapi/pull/7) found no blocking correctness issues; the implementation coordinator accepted the design under the requested implementation and serial-merge workflow. This records the implementation design gate, not human maintainer signoff or approval to release companion APIs. Profile `0.1.0` is not an official Azure or AsyncAPI binding.

[繁體中文](../zh-tw/design/azure-service-bus-profile) |
[Normative JSON Schema](/profiles/azure-service-bus/0.1.0/schema.json) |
[Example contracts](#examples) |
[Review gate](#review-gate)

## 1. Scope and compatibility

This RFC defines **contract requirements**, not SDK options or observed deployment facts. A conforming implementation preserves the broker-neutral core and writes one `x-azure-service-bus` value per target. The extension schema and the cross-object rules below are jointly normative; JSON Schema alone cannot validate topology, standard fields, application code or Azure resources. "Must" describes conformance to this proposed profile, not a new promise from Azure.

| Layer                            | Pinned baseline / proposed support                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AsyncAPI document                | Exactly `3.1.0`; not a floating `3.x` target [A1]                                                                                                                                   |
| TypeSpec compiler                | `1.15.0`                                                                                                                                                                            |
| Core / emitter inspected         | `tsp-asyncapi-core` `0.4.2` / `tsp-asyncapi` `0.7.2`, repository `022e4bb` [R1]                                                                                                     |
| Reproduction                     | Node **24**, pnpm **11.21.0**; compiler 1.15 requires Node >=22, so the older root README's Node >=20 recipe is not this recipe                                                     |
| Planned versioning compatibility | `@typespec/versioning` `0.85.0` with compiler `1.15.0`; no versioned profile conformance claim until #1 integration below                                                           |
| Extension profile                | Proposed `profileVersion: "0.1.0"`; schema dialect Draft-07                                                                                                                         |
| Payload/header dialect           | AsyncAPI 3.1.0 native Schema Object (Draft-07-based); initial companion conformance covers native JSON only                                                                         |
| Future companion/core releases   | Select and pin the **actual released versions containing the approved APIs** when available; core 0.4.2 has no public extension writer. No future package version is assigned here. |

Application `info.version`, a message's schema version, TypeSpec/library versions, AsyncAPI version and `profileVersion` are independent. The schema `$id` is its intended documentation address, not a claim that this proposed version has been published.

Initial scope is separate, unversioned application entrypoints, queues/topics/subscriptions, AMQP 1.0 over TLS, portable application properties, native string metadata, fixed or explicitly constrained native reply routing, and declared delivery requirements. No runtime, Azure SDK, provisioning, credential acquisition, HTTP streaming, HTTP LRO/status polling, scheduler, workflow engine, distributed transaction coordination or automatic compatibility proof is introduced. **Neither exactly-once business effects nor automatic workflow durability is promised.**

## 2. Broker-neutral contract first

| Intent                 | Existing core / AsyncAPI representation                                         | Service Bus interpretation                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Command/event          | `@message` model, optionally `messageKind` below                                | Intent, not a transport primitive. Queue commands and topic events are recommended patterns, not restrictions. |
| Application behavior   | `@send` / `@receive`, standard `operation.action`                               | Relative to the application described, never auto-invert another application's document                        |
| Destination/source     | `@channel` or `@dynamicChannel`, standard channel references                    | Logical entity relation in the profile; physical address only in composition                                   |
| Body                   | Message `payload` and native schema                                             | Application serializes/deserializes bytes; broker treats the body as opaque                                    |
| Application properties | `@headers(Model)` or top-level `@header`, message `headers`                     | AMQP `application-properties` only; portable subset below                                                      |
| Content type           | Existing `@contentType`, message `contentType`                                  | Single source for native `properties/content-type`                                                             |
| Correlation            | Existing `@correlationId` only for a real payload/application-property location | Native-only correlation remains extension metadata                                                             |
| Reply                  | `@replyChannel`, standard `reply.channel` / `reply.messages`                    | Reply relationships and native routing obligations below                                                       |
| Security               | Standard servers, schemes and security references when accurate                 | TLS, identity and data-plane authorization still require composition and runtime implementation                |

For a gateway, `@send op place(command: PlaceOrder): OrderResult` sends the request and receives replies. For its processor, `@receive op process(result: OrderResult): PlaceOrder` receives the request and sends replies. These signatures do not make execution synchronous. A publisher sends to a topic; a fulfillment application receives from a subscription whose `topicId` names that topic even if the topic is absent from its own channels. Queues support either action. This profile rejects send-to-subscription and receive-from-topic [A1, Z1].

### Reuse decisions

| TypeSpec facility       | Decision for the first companion                                                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@typespec/events`      | No new dependency. `@events` unions, `@data` payload selection and `@contentType` on variants/properties differ from existing model-level message semantics. An optional broker-neutral adapter can follow; `unsafe_getEventDefinitions` is experimental, not a stable replacement. [T1] |
| `@typespec/streams`     | No dependency. `@streamOf` describes a stream protocol model, not broker settlement, subscription topology or durable session state. HTTP/SSE streaming remains separate. [T1]                                                                                                           |
| `@typespec/json-schema` | Reuse through a deliberate provider/multi-format route later, not by copying internals or placing Draft 2020-12 keywords into native Draft-07 schemas. #3 owns fidelity and conversion evidence. [T1, A1]                                                                                |
| `@typespec/versioning`  | Reuse snapshots and `@useDependency`, not a second version graph. Initial companion rejects versioned/dependency-mutated profile use until scoped replay and relational diagnostics are integrated with #1/#4. [T1]                                                                      |

## 3. Normative profile interface

The [schema](/profiles/azure-service-bus/0.1.0/schema.json) validates **one extension value**. Its named definitions `info`, `channel`, `message`, `operation` are also placement-specific entrypoints (`#/definitions/channel`, for example). Every object is closed: unknown members are errors, not ignored future options. No `default`, coercion, inferred feature enablement or deep merge is allowed. An omitted optional member means **unspecified**, not false, zero, "latest", disabled, or guaranteed.

Every value has required `profileVersion: "0.1.0"` and `target: "info" | "channel" | "message" | "operation"`. `target` must match the actual emitted object, including objects promoted into `components`; it is not permission to choose a new placement.

| Target                                      | Required additional fields | Optional fields                                 |
| ------------------------------------------- | -------------------------- | ----------------------------------------------- |
| Service namespace -> `info`                 | `asyncapiVersion: "3.1.0"` | None                                            |
| Channel interface/namespace -> channel      | `entity`                   | `deploymentRequirements`                        |
| Marked `@message` model -> message          | None                       | `messageKind`, `nativeProperties`, `ttlSeconds` |
| `@send` / `@receive` operation -> operation | `action: "send"            | "receive"` matching standard action             | `deliveryRequirements`, `applicationObligations`, `authorizationRequirements`, `nativeReply` |

Each profile-bearing application document must have the info declaration. Every channel, operation and message participating in its Service Bus paths, including replies, must carry its matching profile; unrelated broker-neutral paths need not. Profiles do not inherit from info, a channel, an operation or a message. A service namespace must not also be a profile-bearing channel: the current generic extension resolver copies its value to both placements.

**Only these four placements are supported.** No root, server, payload-schema, property, reply-object or trait placement is defined. Server objects still use standard protocol and security fields. Do not emit `amqp` (AMQP 0-9-1) bindings on a profiled path. Every standard `amqp1` binding object, including server/message/operation/channel bindings and referenced binding components, must be **absent (recommended) or `{}`**; even `bindingVersion` is forbidden by the current AMQP 1.0 binding revision [A2]. Other transport bindings on those paths are unsupported by this profile.

### Channel config and topology

`entity` is one of `{kind: "queue", id}`, `{kind: "topic", id}`, or `{kind: "subscription", id, topicId}`. IDs match `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`, at most 128 characters. This is a project identifier convention, **not an Azure entity-name limit**.

IDs identify entities within a shared logical composition/catalog, not operation IDs, component keys, Azure resource IDs or `$ref`s. IDs are case-sensitive. A local ID must have exactly one kind and, for subscriptions, one parent; `topicId != id`. Multiple channel aliases of the same entity are allowed only with mutually compatible requirements. A referenced local parent must be a topic. A parent absent from the document is an explicit external logical relation, not a dangling AsyncAPI reference. Composers must resolve it in the shared catalog; do not add unused topic channels just to satisfy it.

| `deploymentRequirements` member | Type / meaning                                                                                                                              | Legal entity                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `allowedTiers`                  | Nonempty distinct array of `basic`, `standard`, `premium`; each listed tier must support all known requirements                             | All                                                        |
| `sessions`                      | Boolean; require enabled/disabled exactly                                                                                                   | Queue, subscription only                                   |
| `partitioning`                  | Only `"disabled"` in 0.1.0; require nonpartitioned duplicate-detection scope                                                                | Queue, topic                                               |
| `duplicateDetection`            | `{required: true, scope: "messageId", historyWindowSeconds?: integer 20..604800}`; require enabled, and an exact history window if supplied | Queue, topic; requires explicit `partitioning: "disabled"` |
| `lockDurationSeconds`           | Integer 1..300, exact entity lock duration in seconds                                                                                       | Queue, subscription                                        |
| `maxDeliveryCount`              | Integer 1..2147483647, exact broker redelivery limit; not an SDK/business retry count                                                       | Queue, subscription                                        |
| `defaultTtlSeconds`             | Integer 1..2147483647, exact entity default/ceiling TTL                                                                                     | All                                                        |
| `deadLetterOnExpiration`        | Boolean, exact deployment requirement                                                                                                       | Queue, subscription                                        |

Numeric units and bounds are fixed. Whole positive seconds, excluding infinite TTL sentinels, are an intentional portable subset. Known Basic requirements reject topics/subscriptions, `sessions: true`, duplicate detection, or a default TTL over 14 days. With no tier supplied these capabilities remain requirements for Standard/Premium; there is no inferred deployed tier [Z2-Z5, Z8].

Requirements on aliases combine by conjunction, never last-wins: exact settings must agree; `allowedTiers` intersect and must remain nonempty. These checks apply within an emitted application. Agreement across separate applications/environments is composition work, not a claim that the emitter has discovered all deployments.

### Message config and fixed native mappings

`messageKind` optionally classifies `command`, `event`, or `reply`; it does not constrain entity kind. `nativeProperties` accepts **only** the following PascalCase SDK-neutral names. All declared values are nonempty strings in this profile, even where AMQP or a particular SDK supports more types. Constraints describe wire values, not generated values or payload fields.

| Config key                                 | Fixed AMQP 1.0 location        | Config value                                                                      |
| ------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------- |
| `MessageId`                                | `properties/message-id`        | `{required: boolean, const?: string, maxLength?: integer}`; effective maximum 128 |
| `CorrelationId`                            | `properties/correlation-id`    | Same shape, no profile-imposed maximum unless supplied                            |
| `SessionId`                                | `properties/group-id`          | Same shape; effective maximum 128                                                 |
| `ReplyTo`                                  | `properties/reply-to`          | `{required: boolean}` only; value supplied by composition/application routing     |
| `ReplyToSessionId`                         | `properties/reply-to-group-id` | Native string shape; effective maximum 128                                        |
| `Subject`                                  | `properties/subject`           | Native string shape, no profile-imposed maximum unless supplied                   |
| `ContentType`                              | `properties/content-type`      | `{required: true}` only; value comes from standard message `contentType`          |
| Application properties (not native config) | `application-properties`       | Standard message `headers` schema                                                 |

Mappings are fixed by this table, never author-selectable `section`, `name` or transformation strings. `required: false` means optional, not prohibited; all stated constraints still apply if present. The whole native declaration being absent means no requirement, not a generated value. A `const` longer than a declared `maxLength` is an error. MessageId, SessionId and ReplyToSessionId have a 128-character profile ceiling grounded in quotas/SDK limits; runtime implementations must also satisfy their SDK's string-length rules [Z6, Z10]. This RFC does not invent a CorrelationId or Subject limit.

Explicit standard `contentType` is required whenever `nativeProperties.ContentType` is declared. A global AsyncAPI `defaultContentType` is not an implicit replacement for this per-message declaration. No second ContentType literal is accepted by the profile. Subject is not message `name`/`title`. A runtime MessageId is not an operation key/operationId, schema/component name, SessionId or conversation ID. Causation is separately declared in payload or application properties. A send claiming `messageIdentity` below must require MessageId and generate an identity per logical message, stable across retries; reusing an operation ID is invalid application behavior.

`ttlSeconds`, if present, declares an exact producer-set per-message TTL, integer 1..4294967. The application maps seconds to AMQP **`header/ttl` milliseconds** (uint32); it is not a property or an application header. The upper bound is this whole-second AMQP subset, not the entity's maximum retention. Effective TTL can be capped by queue/topic/subscription settings. A known lower ceiling conflicts with the declared exact TTL. Omission leaves per-message TTL unspecified, not automatically set to any broker default [Z4, Z7].

PartitionKey/scheduling annotations, broker-assigned sequence/enqueue/lock/expiry state, DeliveryCount (`header/delivery-count`), session state, deferral and transaction settings are not producer config in 0.1.0. Applications may observe them at runtime; the profile neither maps them into headers nor emits them as writable native fields.

### Portable application properties

Use existing header models, not another property bag in the profile. Resolve standard local schema references before checking: headers must be an object with declared, individually typed scalar properties and `additionalProperties: false`. Empty headers may be omitted. An unbounded/open header bag is unsupported, even though the core supports more general schemas.

| Header wire value | Accepted native JSON schema / application encoding                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| String            | `type: string`; constraints/enum allowed; send as AMQP string                                                                                             |
| Boolean           | `type: boolean`; send as AMQP boolean                                                                                                                     |
| Integer           | `type: integer` with explicit inclusive `minimum` and `maximum` inside -9007199254740991..9007199254740991; send an exactly representable integral number |
| Number            | `type: number`; finite IEEE-754 binary64 values only; application checks loss/overflow                                                                    |

No null, arrays, objects, binary, decimal, unions, implicit date/UUID objects or automatic JSON stringification. A timestamp/UUID/decimal can be deliberately authored as a string with a documented encoding; formats never authorize sending an SDK Date or decimal object. Numeric schemas constrain decoded values, not a particular AMQP integer subtype; applications must preserve the value across SDK encoding/decoding without string-to-number coercion. No default injection. This subset is a cross-SDK project restriction, not a claim that Azure forbids every excluded scalar. Azure quotas still constrain encoded property/message size; a schema cannot prove it [Z6, Z10].

An application property named `CorrelationId`, `Subject`, etc. is legal as a **distinct** application property. Name equality does not turn it into native metadata. Explicit mirrors require the application to write/check both values; the companion must not silently insert, lift, rename or synchronize native fields.

### Operation config, delivery and obligations

`deliveryRequirements` applies only to the operation's **primary receive**, never implicitly to replies. It is `{receiveMode: "peekLock" | "receiveAndDelete", order?: "perSession"}`. A send cannot carry it. If omitted, mode/order are unspecified; omission does not assert a delivery guarantee.

`applicationObligations` is a closed collection of opt-in requirements with these exact values:

| Member              | Value / applicability                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `messageIdentity`   | `"uniquePerMessageStableOnRetry"`; primary send only                                                                             |
| `idempotency`       | `"required"`; receive duplicate handling must avoid repeated business effects according to an application-defined durable policy |
| `settlement`        | `"completeAfterSuccess"`; complete only after successful effects                                                                 |
| `lockLoss`          | `"treatAsUnsettled"`; do not assume a failed/uncertain settlement committed                                                      |
| `failureHandling`   | `"abandonTransientDeadLetterPermanent"` for PeekLock; `"applicationRecovery"` for ReceiveAndDelete                               |
| `loss`              | `"accepted"`; explicit ReceiveAndDelete loss acceptance                                                                          |
| `sessionProcessing` | `"serial"`; one-at-a-time processing within a session                                                                            |
| `expiry`            | `"checkApplicationDeadline"` or `"processIfDelivered"`; choose how delivered/locked but late messages are treated                |
| `deadLetter`        | `"inspectAndRemediate"`; application/operator owns investigation and an explicit discard/replay policy                           |

All except `messageIdentity` are receive-only. No settlement, retry or deadline policy is synthesized from omitted fields. Where a mode/order **is declared**, the following conditional requirements are mandatory, not defaults:

| Declared requirement                                                                  | Required consistency / effect                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `peekLock`                                                                            | Require `settlement`, `lockLoss`, `failureHandling: abandonTransientDeadLetterPermanent`, and `idempotency`. No `loss: accepted`. Client owns lock renewal and settlement outcome handling.                                                                      |
| `receiveAndDelete`                                                                    | Require `loss: accepted` and `failureHandling: applicationRecovery`. No settlement, lock-loss policy, per-session order, serial session processing or dead-letter obligation on this operation. Manual settlement/broker-redelivery recovery cannot be promised. |
| `order: perSession`                                                                   | PeekLock plus `sessionProcessing: serial`, channel `sessions: true`, and `SessionId.required: true` on every participating message                                                                                                                               |
| Send to a session-enabled queue, or receive from a session-enabled queue/subscription | Every participating message requires SessionId; a topic message may carry SessionId for its subscriptions, but the topic itself never has a sessions setting                                                                                                     |
| Duplicate detection required on sending entity                                        | Every sent message requires MessageId, and each primary send declares `messageIdentity`. Apply the same identity obligation to sends represented by replies.                                                                                                     |

Replies needing their own receive policies should also have an explicit receive operation on the reply channel; do not apply the request's receive mode to the inverse reply action. Every reply send remains an application obligation to assign its own MessageId when required, independent of the request's identity.

### Correlation and replies

`nativeReply` has exact shape `{address: "fixedChannel" | "requestReplyTo", correlation: "requestMessageId", session?: "requestReplyToSessionId"}`. It is legal only with a standard `operation.reply` containing explicit `channel` and nonempty `messages`. The first profile supports **queue reply destinations only**; Azure's topic/multicast reply patterns are real but deferred.

| Field                              | Normative application obligation / cross-object condition                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `correlation: requestMessageId`    | Request MessageId required; reply CorrelationId required; responder copies request.MessageId to reply.CorrelationId. Each reply's own MessageId is distinct, not copied.                                                                 |
| `address: fixedChannel`            | Route to the standard reply channel after composition. ReplyTo is optional; if sent, it must agree with that composed destination. "Fixed" means a fixed logical queue, whose physical address may still be null in a reusable document. |
| `address: requestReplyTo`          | Request ReplyTo required; standard reply channel has `address: null`; application resolves and allowlists ReplyTo to the declared logical reply queue. It does not authorize arbitrary destinations or provision queues.                 |
| `session: requestReplyToSessionId` | Request ReplyToSessionId and reply SessionId required; reply queue requires `sessions: true`; responder copies the former to the latter                                                                                                  |

For native-only metadata, omit standard `message.correlationId` and `reply.address`. There is no `$message.properties` expression and no standardized AMQP-properties-to-JSON-header projection in the current `amqp1` binding/core. `$message.header#/CorrelationId` **does not** locate native CorrelationId. A real explicit application-property mirror can instead use that standard expression (encoded wire names and pointer escaping included); a real payload location can use `$message.payload#...`. Existence, requiredness and scalar shape must be checked, not just expression grammar. These standard locations express the mirrored contract, not automatic native mapping [A1, A2, R1].

0.1.0 nativeReply modes do not additionally accept standard `reply.address`; a genuinely application-header-addressed exchange can use core reply facilities without a nativeReply declaration. Both can be valid AsyncAPI, but must not advertise two competing address authorities in this profile. There is no arbitrary extraction/generation DSL: reading an Order.orderId or commandId for SessionId/MessageId, matching replies, validating mirrors, timing out and routing are application code.

## 4. Delivery ownership and limits

| Concern                         | Contract / deployment compatibility                                                                                                    | Application / runtime responsibility and limit                                                                                                                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settlement                      | Explicit mode and conditional obligations above                                                                                        | PeekLock locks may expire or be lost; completion can fail after effects. Renew while needed (entity lock <=5 minutes); handle uncertain outcomes idempotently. ReceiveAndDelete can lose transferred work. [Z7]                                                                                               |
| Duplicate detection             | Queue/topic ingress, enabled over exact window if specified; 20 seconds..7 days; 10-minute Azure default is **not** an emitted default | Only compares MessageId in this profile's explicitly nonpartitioned scope, across the whole entity, not per subscription/operation/session. No receive-side or business-effect deduplication. Beyond the window, a resend may be accepted. [Z2]                                                               |
| Partitioned duplicate detection | Deferred in 0.1.0; do not claim `scope: messageId` when partitioned                                                                    | Azure can use MessageId + PartitionKey; sessions require compatible SessionId/PartitionKey. This limitation is profile policy, not an impossible Azure configuration. [Z2]                                                                                                                                    |
| Order                           | Only per-session order on queue/subscription                                                                                           | Session-lock owner must process serially, including effects. No global/cross-session order; concurrent handlers, dead-letter/replay and resubmission can change observed order. Session state is opaque application data, not workflow durability. [Z3]                                                       |
| Expiration                      | Per-message TTL, entity ceiling/default, and dead-letter-on-expiration are different fields                                            | Effective topic/subscription ceilings matter. Locked work can outlive nominal expiry; TTL does not cancel business effects. An application deadline needs its own payload/header field and clock policy. [Z4]                                                                                                 |
| Retries                         | No single `retryCount`; max delivery count only bounds broker delivery attempts                                                        | Distinguish transient SDK send/settlement retry, PeekLock redelivery, and business retry/replay. Send outcome may be uncertain; retain identity for same-send retry. No scheduled retry engine. Not every lock-loss cause increments DeliveryCount. [Z2, Z5, Z7]                                              |
| Dead letters                    | Queues/subscriptions have built-in DLQ subqueues; no topic DLQ or "enable DLQ" feature                                                 | Exhausted delivery/optional expiration or explicit dead-lettering can move messages there. No automatic TTL cleanup in DLQ. Inspect/remediate/replay explicitly; cannot directly send business messages to a DLQ or dead-letter again from it. Dedicated DLQ operation channels are deferred. [Z5]            |
| Idempotency                     | Opt-in requirement, mandatory with declared PeekLock                                                                                   | Application chooses durable identity/effect tracking, inbox/outbox or equivalent. Broker filtering and successful settlement do not prove exactly-once business effects or unconditional eventual processing.                                                                                                 |
| Evolution                       | Application/schema/profile versions are separate                                                                                       | Retain readers for queued/replayed messages and replies across rolling deployments; include payload, app/native metadata, enum/subject semantics and content-type changes. Optional additions are not universally compatible with strict/closed readers. #3 supplies bounded evidence, not a universal proof. |

Changing a required native field, header type, Subject meaning, enum, serialization or reply policy can break old retained messages even when the payload's JSON shape is unchanged. TypeSpec snapshots neither upgrade stored messages nor rewrite literal profile IDs/strings/runtime expressions.

## 5. Security and composition

All profiled AMQP connections require TLS. Optional `authorizationRequirements` is `{tls: true, authentication?: "entraId" | "sas"}`; omission leaves authentication choice unspecified, **not TLS optional**. This transport invariant is explicit profile scope, not an injected config default. Primary send requires data-plane Send; primary receive requires Listen. A send-with-reply additionally requires Listen on the reply queue; receive-with-reply requires Send there. These rights follow action and topology, not `messageKind`.

Composition supplies physical entity paths, namespace hosts, catalog resolution, deployment capability evidence, identity selection and role assignments. Credentials never belong in reusable contracts or emitted examples. Standard server fields can describe `protocol: amqps`, `protocolVersion: "1.0"`; `amqp1` is the binding name, not that protocol version. Choose `@channel` once in composition, or retain `@dynamicChannel`/`address: null` in an unbound reusable contract. Do not augment a dynamic channel with a second channel decorator. Environment names are not business channel parameters.

| Authentication                        | Honest representation                                                                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entra ID / managed identity           | Profile requirement plus external identity/RBAC configuration. Standard security schemes do not fully describe managed-identity credential acquisition and AMQP CBS token exchange. Do not fabricate HTTP bearer headers or treat RBAC roles as OAuth scopes. |
| Actual OAuth2 client-credentials flow | Standard `oauth2` only if that precise flow/endpoints/scopes are actually used and supplied in composition; it still does not describe the entire AMQP CBS exchange                                                                                           |
| SAS using SASL PLAIN                  | Standard `type: plain` accurately describes that chosen SASL mechanism; describe policy-name/key usage without embedding either credential. SAS token over CBS is not automatically the same flow.                                                            |

When a real standard scheme is defined, reuse existing `@securityScheme`, `@useSecurity`, standard server/operation security references. Generic tooling may ignore the extension, so Entra requirements are not fully machine-actionable to every AsyncAPI generator. Never manufacture a scheme to make that limitation disappear [A1, Z9].

There is no Azure resource inspector or deployment-facts API in this design. Declared incompatible requirements are errors; unknown deployed facts remain external obligations. A future composer comparing real facts must check tier, sessions, partitioning, TTL ceilings, lock/redelivery settings, authentication and rights without claiming the emitter configured them.

## 6. Conformance and diagnostics

These are **proposed companion diagnostic identifiers**, not existing compiler diagnostics. The schema fixtures test structural rules; the future companion must implement the cross-object rules at source targets. A profile error prevents a claimed-conformant output, rather than dropping the offending requirement and reporting success.

| Proposed diagnostic       | Severity / kind             | Required trigger                                                                                                                                                                   |
| ------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile-shape`           | Error / profile             | Unknown version/member, invalid numeric/string range, unsupported guarantee, nonserializable value, native const exceeds declared bound                                            |
| `profile-placement`       | Error / profile             | Wrong/unmarked target, target discriminator mismatch, missing info or participating profiles, service/channel dual target                                                          |
| `profile-conflict`        | Error / profile             | Multiple typed configs, typed plus raw same key, action mismatch; no merge or last-wins                                                                                            |
| `topology-conflict`       | Error / contract            | Kind/parent/alias setting conflict, self-parent, empty tier intersection, invalid local parent                                                                                     |
| `entity-direction`        | Error / Azure constraint    | Primary or reply direction sends to subscription or receives from topic                                                                                                            |
| `transport-conflict`      | Error / standard/profile    | AMQP 0-9-1/other transport binding, nonempty `amqp1`, known non-TLS/non-AMQP1 server                                                                                               |
| `native-metadata`         | Error / profile             | Unsupported/read-only native field, content-type conflict, missing required MessageId/SessionId/correlation/reply metadata                                                         |
| `application-properties`  | Error / profile subset      | Open/nested/nullable/unsupported header shape or encoding, integer without safe bounds                                                                                             |
| `delivery-conflict`       | Error / contract            | ReceiveAndDelete with manual settlement/order, incomplete PeekLock obligations, session order without capability/metadata                                                          |
| `deployment-incompatible` | Error / Azure constraint    | Known Basic/capability conflict, impossible lock/window/TTL settings; includes contradictory explicit requirements, not guessed Azure facts                                        |
| `profile-unsupported`     | Error / profile scope       | Partitioned dedup, non-queue nativeReply, dedicated DLQ channel, unintegrated versioned/multi-service validation; not necessarily impossible in Azure                              |
| `reply-conflict`          | Error / contract            | Missing standard reply/channel/messages, competing native/standard addresses, wrong dynamic address, missing correlation/session relation                                          |
| `runtime-location`        | Error / contract            | Fake native header/property pointer, or declared standard location not backed by an actual required scalar payload/app property                                                    |
| `deployment-unverified`   | Warning / external evidence | Once per profiled document: emitted requirements have **not** been checked against Azure; identify external topic relations/capabilities to reconcile, no invented observed values |

Schema errors identify JSON paths; typed diagnostics must identify the originating decorator/config argument and related declarations. Do not warn for every omitted optional field. Idempotency, extraction, serialization, routing, settlement and security execution remain documented application obligations, not successful static enforcement.

Cross-object rules use the final application graph, including resolved references and promoted objects. First release may use separate unversioned entrypoints. Versioned/dependency-mutated or combined multi-service profile claims stay unsupported until #1/#4 provide original Program + selected live namespace/type graph + optional Realm + stable service/version identity + scoped declarations and snapshot-aware relational validation. Source-wide `$onValidate` is insufficient. Replay must record on the actual cloned target, with per-target/view aggregation, not AST-position/Program-only caches; literals do not migrate automatically.

## 7. Examples

Download complete, credential-free conceptual AsyncAPI 3.1.0 documents:

| Application | Document / perspective                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway     | [gateway.json](/profiles/azure-service-bus/0.1.0/gateway.json): sends PlaceOrder to logical `orders.commands`, fixed `orders.replies`; explicitly receives results    |
| Processor   | [processor.json](/profiles/azure-service-bus/0.1.0/processor.json): receives PlaceOrder, replies to gateway, sends OrderPlaced to `orders.events`                     |
| Fulfillment | [fulfillment.json](/profiles/azure-service-bus/0.1.0/fulfillment.json): receives OrderPlaced on `orders.fulfillment`, parent `orders.events` absent from its channels |

These are **design fixtures, not output from a new companion**. Null addresses are intentionally unbound. The example composition must supply physical names/hosts later. It assigns orderId to command/event SessionId and commandId to reply-session metadata, explicitly in application code; request MessageId is commandId, whereas event/reply MessageIds are new logical-message identities. A `causationId` application property is distinct from correlation and operation IDs. No native value extraction is performed by the schema.

Current core can carry raw proposed config without any new API:

```typespec
import "tsp-asyncapi";
using AsyncAPI;

@service(#{ title: "Publisher" })
@info(#{ version: "1.0.0" })
@extension("x-azure-service-bus", #{
  profileVersion: "0.1.0", target: "info", asyncapiVersion: "3.1.0"
})
namespace Publisher;

@jsonSchemaExtension("additionalProperties", false)
model AppProperties {
  causationId: string;
}

@message
@contentType("application/json")
@headers(AppProperties)
@extension("x-azure-service-bus", #{
  profileVersion: "0.1.0", target: "message", messageKind: "event",
  nativeProperties: #{ MessageId: #{ required: true }, ContentType: #{ required: true } }
})
model OrderPlaced { orderId: string; }

@dynamicChannel
@extension("x-azure-service-bus", #{
  profileVersion: "0.1.0", target: "channel",
  entity: #{ kind: "topic", id: "orders.events" }
})
interface Events {
  @send
  @extension("x-azure-service-bus", #{
    profileVersion: "0.1.0", target: "operation", action: "send",
    applicationObligations: #{ messageIdentity: "uniquePerMessageStableOnRetry" }
  })
  op publish(event: OrderPlaced): void;
}
```

Generic core checks extension serialization/placement/collisions, **not Service Bus conformance**. `@jsonSchemaExtension` explicitly closes the application-property schema; no native metadata is inserted there. This snippet proposes no Azure decorators.

### Valid variants and invalid mutations

| Change to a fixture                                                                                                                | Result                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Gateway/processor nativeReply `address: requestReplyTo`, with required native ReplyTo on PlaceOrder and null reply-channel address | Valid native-only dynamic-routing variant; app must allowlist/composition-resolve ReplyTo; still no standard reply.address |
| Add a required string application property `requestId` and standard `correlationId.location: "$message.header#/requestId"`         | Valid explicit mirror only when the application writes/checks it; does not redefine native CorrelationId                   |
| Add `sessions: true` to the processor's topic                                                                                      | Invalid schema: sessions belong to queue/subscription                                                                      |
| Remove fulfillment entity `topicId`                                                                                                | Invalid schema: subscription parent required                                                                               |
| Add `nativeProperties.MessageId.source: "$message.payload#/commandId"`                                                             | Invalid schema: no extraction DSL                                                                                          |
| Set duplicate window to 19 or 604801 seconds, or omit required nonpartitioned scope                                                | Invalid schema; valid inclusive endpoints are 20 and 604800                                                                |
| Change PeekLock to ReceiveAndDelete but retain settlement/order                                                                    | Invalid schema; no manual settlement or ordering promise                                                                   |
| Change gateway command action to receive while standard action remains send                                                        | Schema-valid extension, relational `profile-conflict`                                                                      |
| Add `bindings.amqp1.bindingVersion: "0.1.0"`                                                                                       | Structurally outside the extension schema; `transport-conflict`                                                            |
| Set only native CorrelationId and then point to `$message.header#/CorrelationId` without an actual application property            | `runtime-location`; not an interoperable native location                                                                   |
| Topic/subscription with `allowedTiers: ["basic"]`, or session order with optional SessionId                                        | Cross-object/capability error, not proof of runtime enforcement                                                            |

Executable fixtures use existing Ajv/Vitest and the AsyncAPI parser. They cover schema boundaries, closure, conditional shapes and document structure, not a companion validator, live broker behavior or all relational diagnostics.

## 8. Companion handoff and review gate

Proposed package: **`tsp-azure-service-bus`**, namespace **`Azure.ServiceBus`**, a TypeSpec library, not an emitter. Exact public TypeSpec decorator names are an implementation-review decision. The reviewed data interface for #2 is the four closed definitions in the schema: one composite config per target, with no separate native/delivery decorators each writing the same key. Native fields are model-level config, not property decorators. Authors use the existing core fields for content type, payload, headers and replies.

The only necessary new core seam is a narrow **generic extension writer**: actual target, key, plain JSON value and source provenance; same key validation, copy/serialization behavior and deterministic first-source collision diagnostics as raw `@extension`. Aggregate companion-owned config once per target/view, then write `x-azure-service-bus` once. Do not deep-import private decorators, mutate core state symbols, change first-wins to merging, add an Azure binding renderer or expand root/server placement. Read-only generic binding inspection may be added only if current public inspection is insufficient for the agreed diagnostics. Any public API must ship in an actual new release before consumers pin it.

| Gate / record                                                                                            | State                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roadmap source analysis, baseline `022e4bb`, 2026-09-10                                                  | Groundwork only; not maintainer approval                                                                                                                      |
| This RFC + schema + examples                                                                             | Reviewed for initial implementation in [#7](https://github.com/cataggar/tsp-asyncapi/pull/7), 2026-09-10                                                      |
| Placement/closedness/IDs, scalar subset, native/mirror policy, delivery/severity, security, phase limits | Accepted as the initial implementation contract; public decorator APIs still require review                                                                   |
| Independent design review and approval/merge record                                                      | Automated review found no blockers at `7ef1a8f`; coordinator accepted the design. The PR records the eventual merge; no human maintainer signoff is asserted. |
| #2 companion APIs/runtime validation                                                                     | Not implemented here; may begin after this reviewed design is merged                                                                                          |
| #6 runnable profile-backed composition                                                                   | After approved #5 and implemented #2; separate unversioned app entrypoints recommended                                                                        |

Before approval, edits may revise the proposed 0.1.0 artifact. After approval/publication, a changed accepted shape or meaning requires a new profile version/schema path; closed-schema readers must explicitly select a supported version. Do not silently accept a new version as 0.1.0. Package release versions evolve independently.

## Sources and revisions

All references are authoritative upstream sources, reviewed 2026-09-10. Azure prose evolves; the public source snapshot below supplies reproducible revisions rather than claiming these pages are timeless. This RFC summarizes mappings/constraints, not a copy of specification prose.

| ID  | Source / revision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | [AsyncAPI specification, tag v3.1.0](https://github.com/asyncapi/spec/blob/v3.1.0/spec/asyncapi.md): operation perspective, replies, runtime expressions, schema and security                                                                                                                                                                                                                                                                                                                                   |
| A2  | [AMQP 1.0 binding 0.1.0](https://github.com/asyncapi/bindings/blob/1f418fe7077096cc8f25d0c6518df617f7c303f3/amqp1/README.md), bindings commit `1f418fe7077096cc8f25d0c6518df617f7c303f3`                                                                                                                                                                                                                                                                                                                        |
| R1  | [Core extension implementation](https://github.com/cataggar/tsp-asyncapi/blob/022e4bb/packages/tsp-asyncapi-core/src/decorators/extension.ts), [resolution](https://github.com/cataggar/tsp-asyncapi/blob/022e4bb/packages/tsp-asyncapi-core/src/resolve/extensions.ts), [runtime expressions](https://github.com/cataggar/tsp-asyncapi/blob/022e4bb/packages/tsp-asyncapi-core/src/decorators/runtime-expression.ts) at repository baseline `022e4bb`                                                          |
| T1  | [TypeSpec release tree](https://github.com/microsoft/typespec/tree/typespec-stable%401.15.0/packages), tag `typespec-stable@1.15.0` (`f30cd352f93997e04c75d48c7ace6947a1d5d07a`): events `lib/decorators.tsp` / `src/experimental`, streams README, json-schema emitter/README, versioning mutator and compiler experimental mutators                                                                                                                                                                           |
| Z1  | [Queues, topics and subscriptions](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-queues-topics-subscriptions), [messages/payloads/routing](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-messages-payloads)                                                                                                                                                                                                                                             |
| Z2  | [Duplicate detection](https://learn.microsoft.com/en-us/azure/service-bus-messaging/duplicate-detection): ingress scope, partitioning and history window                                                                                                                                                                                                                                                                                                                                                        |
| Z3  | [Sessions](https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-sessions): queues/subscriptions, ordering and state                                                                                                                                                                                                                                                                                                                                                                            |
| Z4  | [Expiration](https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-expiration): TTL ceilings, locked work and expiration handling                                                                                                                                                                                                                                                                                                                                                               |
| Z5  | [Dead-letter queues](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues): built-in subqueues, no TTL cleanup, maximum delivery count                                                                                                                                                                                                                                                                                                                                  |
| Z6  | [Quotas](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-quotas): native IDs and encoded sizes; tier capability claims use focused feature pages rather than generic quota headings                                                                                                                                                                                                                                                                                                   |
| Z7  | [Transfers, locks and settlement](https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-transfers-locks-settlement), [AMQP protocol guide](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-amqp-protocol-guide): property/header/annotation mapping and CBS                                                                                                                                                                                                           |
| Z8  | [Premium/tier comparison](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-premium-messaging)                                                                                                                                                                                                                                                                                                                                                                                          |
| Z9  | [Entra application authentication](https://learn.microsoft.com/en-us/azure/service-bus-messaging/authenticate-application)                                                                                                                                                                                                                                                                                                                                                                                      |
| Z10 | [.NET ServiceBusMessage source, v7.20.2 documentation revision](https://github.com/Azure/azure-sdk-for-net/blob/f81988005453a91be7a974bba8c1b69012758e0f/sdk/servicebus/Azure.Messaging.ServiceBus/src/Primitives/ServiceBusMessage.cs): ReplyToSessionId length and application-property types/binary limitation; [JavaScript message reference](https://learn.microsoft.com/en-us/javascript/api/@azure/service-bus/servicebusmessage?view=azure-node-latest), accessed 2026-09-10, not an SDK dependency pin |

Z1-Z9 source files are under `articles/service-bus-messaging` in [MicrosoftDocs/azure-docs snapshot `4c11faea6dc19ae6f860832f98850d434f5f7d62`](https://github.com/MicrosoftDocs/azure-docs/tree/4c11faea6dc19ae6f860832f98850d434f5f7d62/articles/service-bus-messaging), with the same basename as their Learn URLs. The dedicated DLQ page takes precedence over incidental wording elsewhere suggesting DLQs must be created/enabled.
