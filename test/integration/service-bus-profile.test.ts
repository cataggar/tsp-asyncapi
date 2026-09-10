import { readFile } from "node:fs/promises";
import { Ajv } from "ajv";
import type { AnySchemaObject } from "ajv";
import { describe, expect, it } from "vitest";
import type { AsyncAPIDocument } from "#emitter/types/index.js";
import { channelsOf, infoOf, messagesOf, operationsOf, schemasOf } from "../utils/document.js";
import { emitDocument } from "../utils/test-host.js";

const ROOT = new URL("../../", import.meta.url);
const PROFILE = new URL("docs/public/profiles/azure-service-bus/0.1.0/", ROOT);
const KEY = "x-azure-service-bus";
const VERSION = { profileVersion: "0.1.0" };
const schema = JSON.parse(
  await readFile(new URL("schema.json", PROFILE), "utf8"),
) as AnySchemaObject;
const ajv = new Ajv({
  allErrors: true,
  strict: true,
  // Conditional branches constrain properties defined in other branches/references.
  strictRequired: false,
  strictTypes: false,
});
const validate = ajv.compile(schema);

async function example(name: string): Promise<AsyncAPIDocument> {
  return JSON.parse(await readFile(new URL(`${name}.json`, PROFILE), "utf8")) as AsyncAPIDocument;
}

function profiles(doc: AsyncAPIDocument): [string, unknown][] {
  return [
    ["info", infoOf(doc)[KEY]],
    ...Object.values(channelsOf(doc)).map((channel): [string, unknown] => [
      "channel",
      channel[KEY],
    ]),
    ...Object.values(messagesOf(doc)).map((message): [string, unknown] => [
      "message",
      message[KEY],
    ]),
    ...Object.values(operationsOf(doc)).map((operation): [string, unknown] => [
      "operation",
      operation[KEY],
    ]),
  ];
}

function channel(deploymentRequirements: Record<string, unknown>, kind = "queue") {
  return {
    ...VERSION,
    target: "channel",
    entity: { kind, id: "orders.commands" },
    deploymentRequirements,
  };
}

function message(nativeProperties: Record<string, unknown>) {
  return { ...VERSION, target: "message", nativeProperties };
}

const PEEK_LOCK = {
  ...VERSION,
  target: "operation",
  action: "receive",
  deliveryRequirements: { receiveMode: "peekLock", order: "perSession" },
  applicationObligations: {
    idempotency: "required",
    settlement: "completeAfterSuccess",
    lockLoss: "treatAsUnsettled",
    failureHandling: "abandonTransientDeadLetterPermanent",
    sessionProcessing: "serial",
  },
};

describe("Design: proposed Service Bus 0.1.0 extension schema", () => {
  it("is a valid Draft-07 schema, with no injected defaults", () => {
    expect(ajv.validateSchema(schema), ajv.errorsText()).toBe(true);
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(JSON.stringify(schema)).not.toContain('"default":');
    const minimal = { ...VERSION, target: "message" };
    const before = structuredClone(minimal);
    expect(validate(minimal), ajv.errorsText(validate.errors)).toBe(true);
    expect(minimal).toEqual(before);
  });

  it.each(["info", "channel", "message", "operation"])(
    "exposes the placement-specific %s definition",
    (target) => {
      expect(ajv.getSchema(`${String(schema.$id)}#/definitions/${target}`)).toBeTypeOf("function");
    },
  );

  it.each([
    ["unsupported version", { profileVersion: "0.2.0", target: "message" }],
    ["root placement", { ...VERSION, target: "root" }],
    ["server placement", { ...VERSION, target: "server" }],
    ["wrong AsyncAPI version", { ...VERSION, target: "info", asyncapiVersion: "3.0.0" }],
    ["unknown member", { ...VERSION, target: "message", exactlyOnce: true }],
    ["missing subscription parent", channel({ sessions: true }, "subscription")],
    ["topic session capability", channel({ sessions: true }, "topic")],
    ["topic settlement setting", channel({ maxDeliveryCount: 10 }, "topic")],
    [
      "invalid logical ID",
      { ...channel({ sessions: true }), entity: { kind: "queue", id: "/prod/q" } },
    ],
    [
      "unknown entity field",
      { ...channel({ sessions: true }), entity: { kind: "queue", id: "q", host: "h" } },
    ],
    ["writable broker state", message({ DeliveryCount: { required: true } })],
    [
      "property extraction",
      message({ MessageId: { required: true, source: "$message.payload#/id" } }),
    ],
    [
      "renamed native mapping",
      message({ SessionId: { required: true, section: "application-properties" } }),
    ],
    ["numeric native ID", message({ MessageId: { required: true, const: 123 } })],
    [
      "second content-type source",
      message({ ContentType: { required: true, const: "application/json" } }),
    ],
    [
      "physical reply address",
      message({ ReplyTo: { required: true, const: "orders.prod.replies" } }),
    ],
    [
      "missing dedup scope",
      channel({ partitioning: "disabled", duplicateDetection: { required: true } }),
    ],
    [
      "implicit partitioning",
      channel({ duplicateDetection: { required: true, scope: "messageId" } }),
    ],
    ["send with receive requirements", { ...PEEK_LOCK, action: "send" }],
    [
      "lossy receive with settlement",
      {
        ...PEEK_LOCK,
        deliveryRequirements: { receiveMode: "receiveAndDelete" },
      },
    ],
    [
      "PeekLock without explicit obligations",
      {
        ...VERSION,
        target: "operation",
        action: "receive",
        deliveryRequirements: { receiveMode: "peekLock" },
      },
    ],
    [
      "global order",
      {
        ...PEEK_LOCK,
        deliveryRequirements: { receiveMode: "peekLock", order: "global" },
      },
    ],
    [
      "serial session processing without order",
      {
        ...PEEK_LOCK,
        deliveryRequirements: { receiveMode: "peekLock" },
      },
    ],
    [
      "TLS opt-out",
      {
        ...VERSION,
        target: "operation",
        action: "send",
        authorizationRequirements: { tls: false },
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(validate(value), JSON.stringify(value)).toBe(false);
    expect(validate.errors?.length).toBeGreaterThan(0);
  });

  it.each([
    [19, false],
    [20, true],
    [600, true],
    [604800, true],
    [604801, false],
    [20.5, false],
  ])("duplicate window %s seconds has acceptance %s", (historyWindowSeconds, valid) => {
    expect(
      validate(
        channel({
          partitioning: "disabled",
          duplicateDetection: { required: true, scope: "messageId", historyWindowSeconds },
        }),
      ),
      ajv.errorsText(validate.errors),
    ).toBe(valid);
  });

  it.each(["MessageId", "SessionId", "ReplyToSessionId"])(
    "bounds %s literals and declared maximums at 128",
    (name) => {
      expect(
        validate(message({ [name]: { required: true, const: "a".repeat(128), maxLength: 128 } })),
      ).toBe(true);
      expect(validate(message({ [name]: { required: true, const: "a".repeat(129) } }))).toBe(false);
      expect(validate(message({ [name]: { required: false, maxLength: 129 } }))).toBe(false);
    },
  );

  it.each([
    ["lockDurationSeconds", 1, true],
    ["lockDurationSeconds", 300, true],
    ["lockDurationSeconds", 0, false],
    ["lockDurationSeconds", 301, false],
    ["maxDeliveryCount", 1, true],
    ["maxDeliveryCount", 0, false],
    ["defaultTtlSeconds", 1, true],
    ["defaultTtlSeconds", -1, false],
  ])("%s=%s has acceptance %s", (field, value, valid) => {
    expect(validate(channel({ [field]: value })), ajv.errorsText(validate.errors)).toBe(valid);
  });

  it.each([
    [1, true],
    [4294967, true],
    [0, false],
    [4294968, false],
    [1.5, false],
  ])("per-message TTL %s has acceptance %s", (ttlSeconds, valid) => {
    expect(validate({ ...VERSION, target: "message", ttlSeconds })).toBe(valid);
  });

  it("accepts explicit loss, native string constraints and both reply address policies", () => {
    expect(
      validate({
        ...VERSION,
        target: "operation",
        action: "receive",
        deliveryRequirements: { receiveMode: "receiveAndDelete" },
        applicationObligations: { loss: "accepted", failureHandling: "applicationRecovery" },
      }),
      ajv.errorsText(validate.errors),
    ).toBe(true);
    expect(validate(PEEK_LOCK), ajv.errorsText(validate.errors)).toBe(true);
    expect(
      validate(
        message({
          MessageId: { required: true },
          CorrelationId: { required: false, maxLength: 256 },
          SessionId: { required: true },
          ReplyTo: { required: true },
          ReplyToSessionId: { required: true },
          Subject: { required: true, const: "orders.placed.v1" },
          ContentType: { required: true },
        }),
      ),
      ajv.errorsText(validate.errors),
    ).toBe(true);
    for (const address of ["fixedChannel", "requestReplyTo"]) {
      expect(
        validate({
          ...VERSION,
          target: "operation",
          action: "send",
          nativeReply: {
            address,
            correlation: "requestMessageId",
            session: "requestReplyToSessionId",
          },
        }),
        ajv.errorsText(validate.errors),
      ).toBe(true);
    }
  });
});

describe("Design: Service Bus document fixtures (not runtime conformance)", () => {
  it.each(["gateway", "processor", "fulfillment"])(
    "%s is AsyncAPI 3.1.0 with a valid profile at each participating placement",
    async (name) => {
      const doc = await example(name);
      expect(doc.asyncapi).toBe("3.1.0");
      await expect(doc).toBeValidAsyncAPI();
      const entries = profiles(doc);
      expect(entries.length).toBeGreaterThan(3);
      for (const [target, value] of entries) {
        expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
        expect(value).toHaveProperty("target", target);
      }
      expect(doc.servers).toBeUndefined();
      for (const value of Object.values(channelsOf(doc))) {
        expect(value.address).toBeNull();
        expect(value.bindings).toBeUndefined();
      }
      for (const value of Object.values(operationsOf(doc))) {
        expect(value.bindings).toBeUndefined();
        expect(value[KEY]).toHaveProperty("action", value.action);
      }
      for (const value of Object.values(messagesOf(doc))) {
        expect(value.bindings).toBeUndefined();
        expect(value.correlationId).toBeUndefined();
        expect(value.contentType).toBe("application/json");
        expect(value).not.toHaveProperty("headers.properties.MessageId");
        expect(value).not.toHaveProperty("headers.properties.SessionId");
        expect(value).not.toHaveProperty("headers.properties.CorrelationId");
        expect(value.payload).not.toHaveProperty("properties.MessageId");
      }
    },
  );

  it("keeps shared contracts identical across independent application perspectives", async () => {
    const gateway = await example("gateway");
    const processor = await example("processor");
    const fulfillment = await example("fulfillment");
    const gatewayMessages = messagesOf(gateway);
    const processorMessages = messagesOf(processor);
    expect(gatewayMessages.PlaceOrder).toEqual(processorMessages.PlaceOrder);
    expect(gatewayMessages.OrderResult).toEqual(processorMessages.OrderResult);
    expect(processorMessages.OrderPlaced).toEqual(messagesOf(fulfillment).OrderPlaced);
    expect(operationsOf(gateway).placeOrder.action).toBe("send");
    expect(operationsOf(processor).processOrder.action).toBe("receive");
    expect(operationsOf(processor).publishOrderPlaced.action).toBe("send");
    expect(operationsOf(fulfillment).fulfillOrder.action).toBe("receive");
    expect(channelsOf(fulfillment)).toHaveProperty("orders");
    expect(Object.keys(channelsOf(fulfillment))).toHaveLength(1);
    expect(channelsOf(fulfillment).orders[KEY]).toHaveProperty("entity.topicId", "orders.events");
    for (const operation of [
      operationsOf(gateway).placeOrder,
      operationsOf(processor).processOrder,
    ]) {
      expect(operation.reply).toHaveProperty("channel.$ref", "#/channels/results");
      expect(operation.reply).not.toHaveProperty("address");
      expect(operation[KEY]).toHaveProperty("nativeReply.address", "fixedChannel");
    }
  });

  it.each(["yaml", "json"])(
    "the RFC's existing-core TypeSpec snippet preserves four profiles through %s emission",
    async (fileType) => {
      const rfc = await readFile(new URL("docs/design/azure-service-bus-profile.md", ROOT), "utf8");
      const snippet = /```typespec\n([\s\S]*?)```/u.exec(rfc);
      expect(snippet).not.toBeNull();
      if (snippet === null) throw new Error("The RFC has no TypeSpec example.");
      const preamble = 'import "tsp-asyncapi";\nusing AsyncAPI;\n';
      expect(snippet[1].startsWith(preamble)).toBe(true);
      // The existing test host supplies this import and using statement.
      const doc = await emitDocument(snippet[1].slice(preamble.length), { "file-type": fileType });
      expect(doc.asyncapi).toBe("3.1.0");
      await expect(doc).toBeValidAsyncAPI();
      expect(profiles(doc)).toHaveLength(4);
      for (const [target, value] of profiles(doc)) {
        expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
        expect(value).toHaveProperty("target", target);
      }
      expect(messagesOf(doc).OrderPlaced.headers).toEqual({
        $ref: "#/components/schemas/AppProperties",
      });
      expect(schemasOf(doc).AppProperties).toEqual({
        type: "object",
        additionalProperties: false,
        properties: { causationId: { type: "string" } },
        required: ["causationId"],
      });
      expect(messagesOf(doc).OrderPlaced.correlationId).toBeUndefined();
    },
  );
});
