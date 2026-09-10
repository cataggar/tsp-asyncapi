# tsp-azure-service-bus

A **TypeSpec library** for the closed `x-azure-service-bus` contract profile
`0.1.0` on AsyncAPI **3.1.0**. It is not an emitter, Azure SDK, runtime,
provisioning tool, or official Azure/AsyncAPI binding.

[繁體中文](./README.zh-TW.md) ·
[Reference](https://tsp-asyncapi.marvinhsu.dev/reference/service-bus) ·
[Normative schema](https://tsp-asyncapi.marvinhsu.dev/profiles/azure-service-bus/0.1.0/schema.json)

## Compatibility and release status

The initial package manifest is **unpublished**. Develop from this workspace
using Node **24** (package minimum **22**), pnpm **11.21.0**, TypeSpec **1.16.0**,
and `@typespec/versioning` **0.86.0**. The compiler peer range deliberately stays
within the tested minor, `~1.16.0`, with an exact development dependency.

Release this package together with the core minor that introduces the public
extension writer and binding reader. Changesets updates the `workspace:^` core
peer/development range before packing; installed core **0.4.2 has no writer**.
Select actual released package versions after that coordinated release, rather
than assuming the current registry packages support this API. Package versions,
application versions, and `profileVersion` are independent.

Import the library alongside the existing emitter; use
`tsp compile main.tsp --emit tsp-asyncapi`, **not** `--emit tsp-azure-service-bus`.
The emitter is only a development/testing dependency of this package.

## Authoring

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
  }
})
model OrderPlaced {
  orderId: string;
}

@dynamicChannel
@channelProfile(#{
  profileVersion: "0.1.0", target: "channel",
  entity: #{ kind: "topic", id: "orders.events" }
})
interface Events {
  @send
  @operationProfile(#{
    profileVersion: "0.1.0", target: "operation", action: "send",
    applicationObligations: #{
      messageIdentity: "uniquePerMessageStableOnRetry"
    }
  })
  op publish(event: OrderPlaced): void;
}
```

Each decorator takes **one complete config**. `profileVersion`, `target`, and an
operation's matching `action` are required; nothing is injected, inherited, or
merged. Do not combine typed profiles with raw `@extension` on the same target.

Application headers remain explicit, closed AsyncAPI header models. Native
MessageId/CorrelationId/SessionId are not headers; the application writes their
fixed AMQP properties. Keep content type and replies in standard AsyncAPI fields.

## JavaScript and testing

- Root: `getProfile(program, target)`, `PROFILE_VERSION`, `EXTENSION_KEY`,
  `NATIVE_PROPERTY_MAPPINGS`.
- `tsp-azure-service-bus/types`: readonly `InfoProfile`, `ChannelProfile`,
  `MessageProfile`, `OperationProfile`, `ServiceBusProfile`, and nested shapes.
- `tsp-azure-service-bus/testing`: `ServiceBusTester`, importing the core and
  companion libraries with both namespaces in scope, without an emitter.

Ajv validates the packaged normative schema. Types alone do not enforce
closedness, all numeric/string constraints, or cross-object requirements.

## Boundaries

Use separate **unversioned, single-service entrypoints**. Versioned,
dependency-mutated, and combined multi-service profile use is rejected pending
scoped integration. A `deployment-unverified` warning means requirements have
not been checked against Azure.

Composition owns addresses, TLS/identity, permissions, and deployment evidence.
Application code owns serialization, native metadata, correlation, routing,
idempotency, settlement, expiry, retries, and dead letters. Neither exactly-once
business effects nor automatic workflow durability is promised.

## License

MIT
