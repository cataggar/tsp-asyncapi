import "tsp-asyncapi";

namespace Orders.Contracts;

/** AMQP application-properties only. Native properties are deliberately absent. */
@AsyncAPI.jsonSchemaExtension("additionalProperties", false)
model ApplicationProperties {
  @format("uuid")
  traceId: string;

  contractVersion: "1.0";

  /** The triggering command ID on events/replies; assigned by application code. */
  @format("uuid")
  causationId?: string;
}
