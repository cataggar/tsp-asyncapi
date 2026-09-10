---
title: "Azure Service Bus"
description: "Typed contract profiles for Azure Service Bus, using the existing AsyncAPI language."
---

# Azure Service Bus

`tsp-azure-service-bus` is a **TypeSpec library**, not an emitter, runtime, Azure
SDK, or provisioning API. It writes one closed `x-azure-service-bus` profile
`0.1.0` per supported object in an AsyncAPI **3.1.0** contract. It is not an
official Azure or AsyncAPI binding.

[繁體中文](../zh-tw/reference/service-bus) ·
[Approved design](../design/azure-service-bus-profile) ·
[Normative schema](/profiles/azure-service-bus/0.1.0/schema.json)

## Compatibility and release

Use Node **24**, pnpm **11.21.0**, compiler **1.15.0** (peer `~1.15.0`), and
`@typespec/versioning` **0.85.0**. The versioning dependency detects unsupported
versioned/dependency-mutated programs through public APIs; it does not enable
versioned profile support.

The initial package manifest is **unpublished**. The library must ship with the
core minor containing the public generic extension writer and binding reader;
installed core **0.4.2 does not contain the writer**. The companion uses
`workspace:^` for its core peer/development dependency. The normal Changesets
`updateInternalDependencies: "patch"` policy, together with the coupled core
minor and companion Changeset, updates the workspace range before publication.
Pin actual released packages containing these APIs when available. No future
released version is assigned here.

In this workspace, run `pnpm install` and `pnpm build`. Import the companion
alongside `tsp-asyncapi` and compile with
`tsp compile main.tsp --emit tsp-asyncapi`. Do not select the companion as an
emitter. The core library is a peer; the emitter is development/testing-only.

## Four composite decorators

All decorators are in `Azure.ServiceBus`. Each takes the target and a single
`config: valueof` the corresponding public model:

| Decorator           | Target                                                          | Config             | Additional required fields                              |
| ------------------- | --------------------------------------------------------------- | ------------------ | ------------------------------------------------------- |
| `@infoProfile`      | `Namespace` marked `@service`                                   | `InfoProfile`      | `asyncapiVersion: "3.1.0"`                              |
| `@channelProfile`   | `Interface \| Namespace` marked `@channel` or `@dynamicChannel` | `ChannelProfile`   | `entity`                                                |
| `@messageProfile`   | `Model` marked `@message`                                       | `MessageProfile`   | None                                                    |
| `@operationProfile` | `Operation` marked `@send` or `@receive`                        | `OperationProfile` | `action: "send" \| "receive"`, equal to standard action |

**Every config requires** `profileVersion: "0.1.0"` and the matching
`target: "info" | "channel" | "message" | "operation"`. Nothing is injected,
coerced, defaulted, inherited, or deep-merged. Unknown fields are rejected by the
normative schema. TypeSpec/TypeScript shapes assist authoring but are not proof
of conformance.

A profile-bearing service needs an info profile. All participating channels,
operations, and marked messages, including replies, need their own profiles;
unrelated broker-neutral paths need not. A service namespace cannot also be a
profiled channel. Duplicate typed configs and typed/raw `@extension` collisions
are errors. There are no granular native-property or delivery decorators and no
profile on root/server/payload/property/reply/trait objects.

## Complete publisher example

This standalone entrypoint declares a logical topic with no physical address.
It emits requirements, not evidence that an Azure deployment satisfies them.

```typespec
import "tsp-asyncapi";
import "tsp-azure-service-bus";

using AsyncAPI;
using Azure.ServiceBus;

@service(#{ title: "Order Publisher" })
@info(#{ version: "1.0.0" })
@infoProfile(#{
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
@messageProfile(#{
  profileVersion: "0.1.0", target: "message", messageKind: "event",
  nativeProperties: #{
    MessageId: #{ required: true },
    ContentType: #{ required: true }
  },
  ttlSeconds: 300
})
model OrderPlaced {
  orderId: string;
}

@dynamicChannel
@channelProfile(#{
  profileVersion: "0.1.0", target: "channel",
  entity: #{ kind: "topic", id: "orders.events" },
  deploymentRequirements: #{
    allowedTiers: #["standard", "premium"],
    partitioning: "disabled",
    duplicateDetection: #{
      required: true, scope: "messageId", historyWindowSeconds: 600
    },
    defaultTtlSeconds: 3600
  }
})
interface Events {
  @send
  @operationProfile(#{
    profileVersion: "0.1.0", target: "operation", action: "send",
    applicationObligations: #{
      messageIdentity: "uniquePerMessageStableOnRetry"
    },
    authorizationRequirements: #{ tls: true, authentication: "entraId" }
  })
  op publish(event: OrderPlaced): void;
}
```

The application assigns a new native MessageId per logical message, retaining it
on retries. `orderId` and `causationId` are not automatically extracted or copied
into any native field. The header model is explicitly closed with
`@jsonSchemaExtension("additionalProperties", false)`.

## Channels and deployment requirements

`entity` is `{kind: "queue", id}`, `{kind: "topic", id}`, or
`{kind: "subscription", id, topicId}`. IDs match
`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`, at most **128** characters. They are logical
catalog IDs, not physical Azure entity names, resource IDs, or `$ref`s.

A subscription's parent must differ from itself and, if locally present, must
be a topic. An absent parent is an external catalog relation to reconcile, not
a dangling AsyncAPI reference. Aliases of one entity must agree on exact
settings; tier lists intersect and cannot become empty. Send to a subscription
and receive from a topic are rejected, including inverse reply directions.

`deploymentRequirements`, when present, is nonempty:

| Field                    | Exact accepted value                                                              | Applicability                                                           |
| ------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `allowedTiers`           | Nonempty distinct array of `basic`, `standard`, `premium`                         | All; each tier must support known requirements                          |
| `sessions`               | Boolean                                                                           | Queue/subscription                                                      |
| `partitioning`           | `"disabled"`                                                                      | Queue/topic                                                             |
| `duplicateDetection`     | `{required: true, scope: "messageId", historyWindowSeconds?: integer 20..604800}` | Queue/topic; requires explicit disabled partitioning                    |
| `lockDurationSeconds`    | Integer **1..300**                                                                | Queue/subscription                                                      |
| `maxDeliveryCount`       | Integer **1..2147483647**                                                         | Queue/subscription; broker delivery limit, not SDK/business retry count |
| `defaultTtlSeconds`      | Integer **1..2147483647**                                                         | All; exact entity default/ceiling                                       |
| `deadLetterOnExpiration` | Boolean                                                                           | Queue/subscription                                                      |

All time units above are whole seconds, inclusive bounds. Basic cannot satisfy
topics/subscriptions, enabled sessions, duplicate detection, or an entity TTL
over 14 days. Omission means unspecified, not a guessed deployed tier or setting.

## Messages, native properties, and headers

`MessageProfile` optionally adds `messageKind: "command" | "event" | "reply"`,
nonempty `nativeProperties`, and `ttlSeconds` (integer **1..4294967** seconds).
TTL maps to AMQP `header/ttl` **milliseconds**, not an application header; known
lower entity ceilings conflict with an exact per-message TTL requirement.

| Native key         | Fixed AMQP 1.0 location        | Config                     |
| ------------------ | ------------------------------ | -------------------------- |
| `MessageId`        | `properties/message-id`        | `NativeId`                 |
| `CorrelationId`    | `properties/correlation-id`    | `NativeString`             |
| `SessionId`        | `properties/group-id`          | `NativeId`                 |
| `ReplyTo`          | `properties/reply-to`          | `{required: boolean}` only |
| `ReplyToSessionId` | `properties/reply-to-group-id` | `NativeId`                 |
| `Subject`          | `properties/subject`           | `NativeString`             |
| `ContentType`      | `properties/content-type`      | `{required: true}` only    |

`NativeString` is `{required: boolean, const?: string, maxLength?: integer}`:
nonempty strings, positive `maxLength`, and `const` no longer than `maxLength`.
`NativeId` additionally has a **128-character** effective ceiling, including
when `maxLength` is omitted. CorrelationId and Subject have no profile-imposed
maximum. `required: false` means optional, not prohibited.

ContentType requires explicit standard `@contentType` on the message; a global
default is insufficient. No second ContentType literal or customizable AMQP
location is accepted. Read-only broker metadata, DeliveryCount, PartitionKey,
scheduling, transactions, and extraction expressions are not profile fields.

Use standard `@headers(Model)` for **AMQP application-properties**, with
`@jsonSchemaExtension("additionalProperties", false)` on that model. The portable
subset permits strings, booleans, finite numbers, and integers with explicit
inclusive bounds inside **-9007199254740991..9007199254740991**. Null, arrays,
nested objects, binary, unions, and implicit date/decimal encoding are excluded.
Application code remains responsible for lossless SDK encoding and wire quotas.

The initial source validator accepts non-inherited, explicitly closed header
models and string-literal enums/unions that lower to scalar enums. Lifted
`@header` schemas are open in the current core, so use `@headers` instead.
Apply `@headers` to the actual message: a base message's decorator is not inherited.
Header encoding/schema overrides, and raw payload schema overrides other than
boolean model `additionalProperties`, are explicitly unsupported rather than
treated as validated schemas. Required runtime locations must also be visible
in the emitted contract. In TypeSpec object literals, spell the native
constraint field as `` `const` `` because `const` is a language keyword.

An application property named `CorrelationId` is still a distinct application
property. Native-only correlation has no standard header pointer: do not
manufacture `$message.header#/CorrelationId` or `$message.properties`. Use
standard correlation locations only for actual required scalar payload/header
fields that the application writes and checks.

## Receive policies

`deliveryRequirements` applies only to the **primary receive**, never implicitly
to replies. It accepts `receiveMode: "peekLock" | "receiveAndDelete"` and optional
`order: "perSession"`. A send cannot declare receive requirements.

| Mode/order            | Mandatory `applicationObligations`                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `peekLock`            | `idempotency: "required"`, `settlement: "completeAfterSuccess"`, `lockLoss: "treatAsUnsettled"`, `failureHandling: "abandonTransientDeadLetterPermanent"`; no `loss` |
| `receiveAndDelete`    | `loss: "accepted"`, `failureHandling: "applicationRecovery"`; no settlement, lockLoss, order, sessionProcessing, or deadLetter                                       |
| `order: "perSession"` | PeekLock plus `sessionProcessing: "serial"`, channel `sessions: true`, and required native SessionId on every participating message                                  |

The nonempty obligations object also accepts receive-only
`expiry: "checkApplicationDeadline" | "processIfDelivered"` and
`deadLetter: "inspectAndRemediate"`. Only primary sends accept
`messageIdentity: "uniquePerMessageStableOnRetry"`; it requires MessageId.
Fields requiring a receive mode cannot be declared without it. Nothing selects
an SDK policy or proves an application implements these obligations.

Session-enabled queues/subscriptions require SessionId on their participating
messages. Topics never have a sessions setting, though a published message can
carry SessionId for downstream subscriptions. Duplicate detection on a sending
entity requires MessageId and send identity obligations, including reply sends.
For a reply sent by a receive operation into a duplicate-detecting queue,
declare an explicit profiled `@send` operation on that logical queue covering
the reply messages and its `messageIdentity` obligation; a receive operation
cannot itself carry a send-only obligation.

### Complete independent receiver

Compile this as a **separate entrypoint**, not alongside the publisher above.
The parent topic is an external logical relation.

```typespec
import "tsp-asyncapi";
import "tsp-azure-service-bus";

using AsyncAPI;
using Azure.ServiceBus;

@service(#{ title: "Fulfillment" })
@info(#{ version: "1.0.0" })
@infoProfile(#{
  profileVersion: "0.1.0", target: "info", asyncapiVersion: "3.1.0"
})
namespace Fulfillment;

@message
@contentType("application/json")
@messageProfile(#{
  profileVersion: "0.1.0", target: "message", messageKind: "event",
  nativeProperties: #{ SessionId: #{ required: true } }
})
model OrderPlaced {
  orderId: string;
}

@dynamicChannel
@channelProfile(#{
  profileVersion: "0.1.0", target: "channel",
  entity: #{
    kind: "subscription", id: "orders.fulfillment", topicId: "orders.events"
  },
  deploymentRequirements: #{ sessions: true }
})
interface Orders {
  @receive
  @operationProfile(#{
    profileVersion: "0.1.0", target: "operation", action: "receive",
    deliveryRequirements: #{ receiveMode: "peekLock", order: "perSession" },
    applicationObligations: #{
      idempotency: "required",
      settlement: "completeAfterSuccess",
      lockLoss: "treatAsUnsettled",
      failureHandling: "abandonTransientDeadLetterPermanent",
      sessionProcessing: "serial"
    }
  })
  op consume(): OrderPlaced;
}
```

## Standard replies and native correlation

Keep existing `@replyChannel` and standard reply messages. A gateway's
`@send op place(command: PlaceOrder): OrderResult` sends the request and receives
replies; a processor's `@receive op process(result: OrderResult): PlaceOrder`
receives the request and sends replies. This does not make execution synchronous.
Use an explicit receive operation on the reply channel for its own receive policy.

`nativeReply` requires a standard reply with explicit channel and nonempty
messages; profile `0.1.0` supports **queue reply destinations only**:

- `address: "fixedChannel"`: route to the standard logical reply queue after
  composition. Optional native ReplyTo must agree if supplied.
- `address: "requestReplyTo"`: require request ReplyTo and a null-address standard
  reply channel. The application resolves and allowlists that value to the
  declared logical queue; it is not permission to route anywhere.
- Required `correlation: "requestMessageId"`: require request MessageId and reply
  CorrelationId; the responder copies the former to the latter.
- Optional `session: "requestReplyToSessionId"`: require request ReplyToSessionId,
  reply SessionId, and reply queue sessions; the application copies that relation.

Do not add standard `reply.address` when `nativeReply` is present. For native-only
metadata, omit standard message `correlationId` as well. Each reply's own
MessageId is a new logical-message identity, not the request's ID.

## Transport, composition, and limits

AMQP 1.0 over TLS is mandatory. Bindings named `amqp1` must be absent
(recommended) or **`{}`**, without even `bindingVersion`; AMQP 0-9-1 `amqp` and
other transport bindings are unsupported. Known servers must use compatible
TLS/AMQP 1.0 fields, for example `protocol: "amqps"` with `protocolVersion: "1.0"`.

Optional `authorizationRequirements` is
`{tls: true, authentication?: "entraId" | "sas"}`. Omission never makes TLS
optional. Send/Listen permissions follow primary and inverse reply directions.
Composition supplies addresses, hosts, logical catalog resolution, deployment
capability evidence, identities, and role assignments. Do not embed credentials,
invent HTTP bearer headers for AMQP CBS, or express RBAC roles as OAuth scopes.
Standard security schemes remain appropriate only when they describe a real flow.
The initial validator accepts SASL `plain` or an actual OAuth2
`clientCredentials` flow, rejects incompatible HTTP/API-key schemes, and reports
contradictions with explicit Entra/SAS requirements. It does not acquire tokens
or establish that the application's described OAuth/CBS flow is implemented.

Initial support is **unversioned, single-service entrypoints**. Source validation
rejects versioned, dependency-mutated, or multiple-service profile use until
scoped snapshot integration can validate each selected application graph.
Schema validation covers one extension value; source validation covers known
placement, topology, action, native/header, reply, and deployment contradictions.
Neither layer inspects Azure or verifies application execution.

`deployment-unverified` is a warning that declared requirements were not checked
against Azure, including external topic relations. Invalid configs and known
contradictions are errors, not silently discarded requirements. See the
[design diagnostic catalog](../design/azure-service-bus-profile#_6-conformance-and-diagnostics).

Applications own serialization, identity, correlation, routing, idempotency,
lock renewal, settlement outcomes, expiry/deadline handling, and dead letters.
Ingress duplicate detection is not receive/business deduplication; per-session
order is not global order; TTL does not cancel effects. There is no exactly-once
business guarantee, automatic workflow durability, retry engine, or DLQ cleanup.

## JavaScript API and testing

The package root exports `getProfile(program, target)`, `PROFILE_VERSION`
(`"0.1.0"`), `EXTENSION_KEY` (`"x-azure-service-bus"`), and
`NATIVE_PROPERTY_MAPPINGS` with the fixed locations above.

`tsp-azure-service-bus/types` exports readonly `InfoProfile`, `ChannelProfile`,
`MessageProfile`, `OperationProfile`, `ServiceBusProfile`, and nested types.
TypeScript `number`/`string` do not enforce integer bounds, patterns, object
closure, or relational rules. Ajv validates the identical packaged normative
schema with no coercion/default insertion; cross-object checks are additional.

`tsp-azure-service-bus/testing` exports `ServiceBusTester`, preconfigured with
the core and companion libraries plus `AsyncAPI` and `Azure.ServiceBus` in
scope, with **no emitter registered**. For document tests, explicitly select
the existing `tsp-asyncapi` emitter and its testing facilities.
