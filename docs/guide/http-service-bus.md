---
title: "HTTP and Service Bus interoperability"
description: "Share an Order domain model across an HTTP API and distinct Service Bus command, event, and reply contracts."
---

# HTTP and Service Bus interoperability

The public [example](https://github.com/cataggar/tsp-asyncapi/tree/main/examples/19-http-service-bus)
describes three applications and the gateway's separate HTTP entrypoint. It uses
the [Service Bus companion](../reference/service-bus) and its
[reviewed profile](../design/azure-service-bus-profile), not an AMQP 0-9-1 binding.
There is no HTTP server, Azure SDK, provisioning, or credential acquisition here.

[繁體中文](../zh-tw/guide/http-service-bus)

## Share the domain, not every envelope

`domain/order.tsp` declares Order once, without HTTP, AsyncAPI, or Service Bus
annotations. Its built-in constraints are shared by both schema emitters:

```typespec
model Order {
  @format("uuid")
  orderId: string;

  @minLength(1)
  customerId: string;

  @minItems(1)
  items: OrderLine[];
}
```

OrderLine has a nonempty SKU and an integer quantity between **1 and 1000**.
The first example deliberately avoids money precision, version projections,
binary formats, and read/write visibility transformations.

| Contract                                                   | Body                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| HTTP `POST /orders` and successful `GET /orders/{orderId}` | The shared Order                                                                |
| PlaceOrder command                                         | `commandId`, `expiresAt`, `order: Order`                                        |
| OrderPlaced event                                          | `eventId`, `occurredAt`, `expiresAt`, `order: Order`                            |
| OrderCommandResult reply                                   | `commandId`, `orderId`, accepted/rejected outcome, optional reason, `expiresAt` |
| HTTP 202 receipt                                           | `commandId`, `orderId`, `state: pending`                                        |

A shared source model does not mean identical HTTP/message envelopes, identical
schema dialects, or automatic compatibility after evolution. Native metadata is
not a property of the Order domain.

## Flow and application perspectives

1. The caller supplies an Order and UUID `Idempotency-Key`. The gateway uses that
   key as commandId. A runtime implementing this contract must record durable
   submission intent before returning **202**, with
   `Location: /order-submissions/{commandId}`. A conflicting reuse of the key
   produces 409. No implementation of that durability or idempotency is shipped.
2. The gateway sends PlaceOrder to the command queue. The processor receives it
   under a session keyed by orderId, records its business outcome, and sends a
   result to the fixed logical gateway reply queue.
3. On acceptance, the processor also publishes OrderPlaced to the event topic.
   A durable outbox/inbox or equivalent is an application design recommendation,
   not a transaction or workflow engine provided by these contracts.
4. The gateway receives the result and updates its submission/read view.
   `GET /order-submissions/{commandId}` returns pending/accepted/rejected; unknown
   records return 404. **202 is not business acceptance or fulfillment.**
5. Fulfillment receives the event from its subscription. It does not receive
   directly from the publisher's topic endpoint, and nobody sends to a subscription.
   A result and event may arrive in either order.

| Document    | Operation            | Primary action and endpoint | Linked reply   |
| ----------- | -------------------- | --------------------------- | -------------- |
| Gateway     | `submitOrder`        | send to command queue       | receive result |
| Gateway     | `receiveResult`      | receive from reply queue    | none           |
| Processor   | `processOrder`       | receive from command queue  | send result    |
| Processor   | `sendResult`         | send to reply queue         | none           |
| Processor   | `publishOrderPlaced` | send to topic               | none           |
| Fulfillment | `onOrderPlaced`      | receive from subscription   | none           |

`@send op submitOrder(command: PlaceOrder): OrderCommandResult` describes the
gateway. `@receive op processOrder(result: OrderCommandResult): PlaceOrder`
inverts the signature: its return is the received request, its parameter is the
sent reply. Return notation is **not a synchronous call or an HTTP waiting rule**.

The explicit result operations describe the **same reply leg**, not a second
delivery. The gateway needs its own receive/settlement policy; that cannot inherit
from a send operation. The processor needs an explicit send identity obligation
for its duplicate-detecting reply queue. Existing `@replyChannel` links the exchange;
there is no standard `reply.address` or synthetic native-header expression.

## Native properties and application headers

`fixtures/flow.json` gives fixed, valid sample values. These are logical fixture
views, not wire captures or code that automatically extracts properties:

| Native property  | Command                                        | Result                   | Event                 |
| ---------------- | ---------------------------------------------- | ------------------------ | --------------------- |
| MessageId        | commandId                                      | distinct result ID       | eventId               |
| CorrelationId    | commandId, by explicit conversation convention | request MessageId        | originating commandId |
| SessionId        | orderId                                        | request ReplyToSessionId | orderId               |
| ReplyTo          | composed gateway reply queue                   | absent                   | absent                |
| ReplyToSessionId | commandId                                      | absent                   | absent                |
| Subject          | `order.place`                                  | `order.result`           | `order.placed`        |
| ContentType      | `application/json`                             | `application/json`       | `application/json`    |

Each logical message has a distinct ID, retained when retrying **that same
message**. MessageId is not an operation ID. Correlation is not causation:
application headers independently declare `traceId`, `contractVersion`, and an
optional `causationId`; event/result fixtures set the latter to the triggering
command ID. No native field is copied into headers.

The profile fixes MessageId to AMQP `properties/message-id`, CorrelationId to
`properties/correlation-id`, SessionId to `properties/group-id`, ReplyTo to
`properties/reply-to`, and ReplyToSessionId to `properties/reply-to-group-id`.
Content type remains a standard message field. `ttlSeconds: 3600` requires the
application to set AMQP **header/ttl to 3,600,000 milliseconds**, not an application
property.

Fixed ReplyTo must agree with the composed reply channel. The responder actively
routes the result there; Service Bus does not automatically execute reply routing.
There is no arbitrary caller-chosen destination or extraction DSL. Correlation
and session equality across messages are application obligations checked only
against these fixtures—not assertions JSON Schema can enforce across deliveries.

## Deployment, security, and delivery obligations

`environments/public.tsp` separates inert `.invalid` hosts and illustrative
physical entity paths from logical catalog IDs. The fulfillment subscription's
`topicId: orders.events` is a cross-document catalog relation, not a dangling
AsyncAPI `$ref`. Do not add an unused local topic to the consumer just to hide it.

Connections require TLS, with `amqps` and protocol version `1.0`. Broker Entra ID
authentication, identity selection, and role assignments stay external. The HTTP
bearer requirement does not assert that its token is valid for AMQP CBS. Do not
invent a standard broker bearer scheme or describe Azure RBAC roles as OAuth scopes.

| Application | Minimum data-plane rights at the narrowest supported scope |
| ----------- | ---------------------------------------------------------- |
| Gateway     | Send on commands; Listen on gateway replies                |
| Processor   | Listen on commands; Send on replies and event topic        |
| Fulfillment | Listen on its subscription                                 |

No control-plane permissions, client secrets, connection strings, private endpoints,
or live resources are needed to compile or validate.

- Require Standard/Premium capabilities, sessions on queues/subscription, a
  30-second lock, maximum delivery count 10, and a 24-hour entity TTL ceiling.
  The **topic has no sessions setting**; the sender supplies SessionId for consumers.
- Commands, replies, and topic ingress require nonpartitioned duplicate detection
  with an explicit **600-second window**. This is bounded broker filtering, not
  durable business idempotency. IDs must remain stable when send outcomes are uncertain.
- Primary receives explicitly require PeekLock, serial per-session processing,
  durable idempotency, completion after successful effects, and treating lost
  locks as unsettled. Lock renewal and successful settlement remain runtime work.
- Transient failures are abandoned; permanent failures and exhausted deliveries
  need dead-letter handling. Expiration is configured for queue/subscription
  dead-lettering. DLQs require inspection/remediation; there is no automatic TTL
  cleanup or safe replay implementation.
- `expiresAt` is an application deadline to check, independent of broker TTL.
  TTL does not cancel a locked message's business effects.
- There is no global ordering across sessions or destinations, unconditional
  eventual delivery, automatic workflow durability, or exactly-once business effect.
  Redelivery and duplicate processing attempts remain possible.

## Generate and verify

Use Node **24**, pnpm **11.21.0**, the root frozen lockfile and workspace packages.
The verified TypeSpec baseline is compiler/HTTP/OpenAPI/OpenAPI3 **1.16.0**
and Protobuf/versioning **0.86.0** where used. Output versions are independently
OpenAPI **3.1.0**, AsyncAPI **3.1.0**, and profile **0.1.0**.

The companion is **unpublished**. Use the workspace checkout until its coordinated
release with a core version containing the required extension APIs, then pin
actual published versions. A package manifest does not establish release availability.

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm examples:interop
pnpm examples:interop:check
pnpm exec vitest run test/integration/http-service-bus-example.test.ts test/integration/http-service-bus-payloads.test.ts
pnpm run docs:build
```

All four entrypoints have their own config. The root is the gateway messaging
default; `/http`, `/processor`, and `/fulfillment` are independent projects.
The generator reads the real configs and captures eight outputs in memory before
writing anything. Check mode compares exact bytes and rejects missing/unexpected
artifacts; it never rewrites baselines. No timestamps or random IDs are generated.

The existing CI Vitest invocation runs the generation check, official AsyncAPI
parser, offline OpenAPI validator, local-reference and profile checks, and actual
valid/invalid payload/header/native-fixture controls. HTTP uses OpenAPI/2020-12;
messaging uses the shared `createPayloadValidator` and `createMessageValidator`
**Draft-07** lane, with explicit formats and no coercion, defaults, or field removal.
These helpers return acceptance and string diagnostics; HTTP remains on its own
reviewed OpenAPI/2020-12 validator, not a substituted messaging oracle. Native
properties remain separate fixture checks. Other schema languages and evolution
scenarios need additional evidence beyond this selected native JSON example.
Samples originating from HTTP, commands, and events are checked against both sides;
complete envelopes are also tested so wrong-level extraction cannot pass unnoticed.

The known `deployment-unverified` warning is expected and preserved. Static
profile/schema validation is not Azure deployment verification, runtime security,
settlement, deduplication, or proof of universal producer/consumer compatibility.
