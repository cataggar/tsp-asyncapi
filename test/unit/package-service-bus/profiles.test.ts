import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTester } from "@typespec/compiler/testing";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { getExtensions, isPlainObject } from "tsp-asyncapi-core";
import { EXTENSION_KEY, getProfile, NATIVE_PROPERTY_MAPPINGS } from "tsp-azure-service-bus";
import { ServiceBusTester } from "tsp-azure-service-bus/testing";
import type { NativeProperties, NativeString } from "tsp-azure-service-bus/types";
import type { AsyncAPIDocument } from "#emitter/types/index.js";
import { channelsOf, messagesOf, operationsOf } from "../../utils/document.js";
import { targetText } from "../../utils/diagnostics.js";

const ROOT = new URL("../../../", import.meta.url);
const tester = createTester(fileURLToPath(new URL("packages/tsp-azure-service-bus/", ROOT)), {
  libraries: ["tsp-asyncapi", "tsp-azure-service-bus", "@typespec/versioning"],
})
  .importLibraries()
  .using("AsyncAPI", "Azure.ServiceBus", "TypeSpec.Versioning");
const VERSION = { profileVersion: "0.1.0" };
const INFO = { ...VERSION, target: "info", asyncapiVersion: "3.1.0" };
const MESSAGE = {
  ...VERSION,
  target: "message",
  nativeProperties: { MessageId: { required: true }, ContentType: { required: true } },
};
const CHANNEL = { ...VERSION, target: "channel", entity: { kind: "queue", id: "orders.commands" } };
const SEND = {
  ...VERSION,
  target: "operation",
  action: "send",
  applicationObligations: { messageIdentity: "uniquePerMessageStableOnRetry" },
};
const RECEIVE = {
  ...VERSION,
  target: "operation",
  action: "receive",
  deliveryRequirements: { receiveMode: "peekLock" },
  applicationObligations: {
    idempotency: "required",
    settlement: "completeAfterSuccess",
    lockLoss: "treatAsUnsettled",
    failureHandling: "abandonTransientDeadLetterPermanent",
  },
};

function value(input: unknown): string {
  if (Array.isArray(input)) return `#[${input.map(value).join(", ")}]`;
  if (isPlainObject(input)) {
    const entries = Object.entries(input).map(([key, item]) => `\`${key}\`: ${value(item)}`);
    return "#{" + entries.join(", ") + "}";
  }
  return JSON.stringify(input);
}

function decoration(target: string, config: unknown, raw = false): string {
  return raw
    ? `@extension("${EXTENSION_KEY}", ${value(config)})`
    : `@${target}Profile(${value(config)})`;
}

interface Options {
  readonly info?: unknown;
  readonly message?: unknown;
  readonly channel?: unknown;
  readonly operation?: unknown;
  readonly raw?: boolean;
  readonly action?: "send" | "receive";
  readonly extra?: string;
  readonly messageDecorators?: string;
  readonly channelDecorators?: string;
  readonly operationDecorators?: string;
  readonly serviceDecorators?: string;
  readonly beforeService?: string;
  readonly body?: string;
  readonly returnType?: string;
  readonly markMessage?: boolean;
}

function contract(options: Options = {}): string {
  const {
    info = INFO,
    message = MESSAGE,
    channel = CHANNEL,
    operation = SEND,
    raw = false,
    action = "send",
    extra = "",
    messageDecorators = "",
    channelDecorators = "",
    operationDecorators = "",
    serviceDecorators = "",
    beforeService = "",
    body = "id: string;",
    returnType = "void",
    markMessage = true,
  } = options;
  const receiveSignature =
    returnType === "void" ? "op execute(): Command;" : `op execute(reply: ${returnType}): Command;`;
  const signature =
    action === "send" ? `op execute(command: Command): ${returnType};` : receiveSignature;
  return `
    ${beforeService}
    @service(#{title: "Orders"})
    ${decoration("info", info, raw)} ${serviceDecorators}
    namespace App {
    ${extra}
    ${markMessage ? "@message" : ""}
    @contentType("application/json")
    ${decoration("message", message, raw)} ${messageDecorators}
    model Command { ${body} }
    @dynamicChannel
    ${decoration("channel", channel, raw)} ${channelDecorators}
    interface Commands {
      @${action}
      ${decoration("operation", operation, raw)} ${operationDecorators}
      ${signature}
    }
    }
  `;
}

async function compile(source: string, options: Record<string, unknown> = {}) {
  const [result, diagnostics] = await tester
    .emit("tsp-asyncapi", { "file-type": "json", ...options })
    .compileAndDiagnose(source);
  const outputs: Record<string, string | undefined> = result.outputs;
  const text = outputs["asyncapi.json"];
  const doc = text === undefined ? undefined : (JSON.parse(text) as AsyncAPIDocument);
  return { result, diagnostics, doc };
}

async function rejected(options: Options, code: string) {
  const compiled = await compile(contract(options));
  const matching = compiled.diagnostics.filter(
    (diagnostic) => diagnostic.code === `tsp-azure-service-bus/${code}`,
  );
  expect(
    matching,
    compiled.diagnostics
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("\n"),
  ).not.toHaveLength(0);
  expect(matching.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
  expect(compiled.doc).toBeUndefined();
  return { ...compiled, matching };
}

describe("Service Bus: typed and raw profile conformance", () => {
  it("provides a standalone compiler tester without registering an emitter", async () => {
    const [{ program }, diagnostics] = await ServiceBusTester.compileAndDiagnose(contract());
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "tsp-azure-service-bus/deployment-unverified",
    ]);
    expect(program.emitters).toEqual([]);
    const service = program.getGlobalNamespaceType().namespaces.get("App");
    if (!service) throw new Error("Missing test service.");
    expect(getProfile(program, service)).toEqual(INFO);
  });

  it.each([false, true])(
    "emits all four closed profiles (raw=%s), preserving native/header separation",
    async (raw) => {
      const { diagnostics, doc } = await compile(
        contract({
          raw,
          extra: `@jsonSchemaExtension("additionalProperties", false) model AppProperties { causationId: string; @minValue(0) @maxValue(5) attempts?: int32; enabled?: boolean; weight?: float64; }`,
          messageDecorators: "@headers(AppProperties)",
        }),
      );
      expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "tsp-azure-service-bus/deployment-unverified",
      ]);
      expect(doc).toBeDefined();
      await expect(doc).toBeValidAsyncAPI();
      if (!doc) throw new Error("Missing document.");
      expect(doc.info[EXTENSION_KEY]).toEqual(INFO);
      expect(channelsOf(doc).Commands[EXTENSION_KEY]).toEqual(CHANNEL);
      expect(operationsOf(doc).execute[EXTENSION_KEY]).toEqual(SEND);
      expect(messagesOf(doc).Command[EXTENSION_KEY]).toEqual(MESSAGE);
      expect(messagesOf(doc).Command).toHaveProperty("headers.$ref");
      expect(messagesOf(doc).Command.correlationId).toBeUndefined();
      expect(doc.components?.schemas?.Command).not.toHaveProperty("properties.MessageId");
    },
  );

  it("exports fixed AMQP 1.0 native property locations", () => {
    expect(NATIVE_PROPERTY_MAPPINGS).toEqual({
      MessageId: "properties/message-id",
      CorrelationId: "properties/correlation-id",
      SessionId: "properties/group-id",
      ReplyTo: "properties/reply-to",
      ReplyToSessionId: "properties/reply-to-group-id",
      Subject: "properties/subject",
      ContentType: "properties/content-type",
    });
    expect(Object.isFrozen(NATIVE_PROPERTY_MAPPINGS)).toBe(true);
  });

  it("accepts numeric scalar/literal headers and ignores fields omitted from output", async () => {
    const { diagnostics, doc } = await compile(
      contract({
        extra: `enum Status { ready, busy }
          @jsonSchemaExtension("additionalProperties", false)
          model AppProperties { fraction?: numeric; constant?: 1.5; status?: Status.ready; @invisible(Lifecycle) internal: bytes; }`,
        messageDecorators: "@headers(AppProperties)",
      }),
    );
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    await expect(doc).toBeValidAsyncAPI();
    expect(doc?.components?.schemas?.AppProperties).not.toHaveProperty("properties.internal");
  });

  it("accepts closed scalar-enum headers and integer bounds declared on a scalar", async () => {
    const { diagnostics, doc } = await compile(
      contract({
        extra: `
        enum Stage { initial: "new", ready }
        @minValue(0) @maxValue(3) scalar Attempts extends int32;
        @jsonSchemaExtension("additionalProperties", false)
        model AppProperties {
          stage: Stage;
          mode: "normal" | "urgent";
          fixed: "constant";
          enabled: true;
          attempts?: Attempts;
        }`,
        messageDecorators: "@headers(AppProperties)",
      }),
    );
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    await expect(doc).toBeValidAsyncAPI();
    expect(doc).toHaveProperty("components.schemas.AppProperties.properties.attempts");
  });

  it("rejects a raw profile even when generic serialization dropped its value", async () => {
    const source = contract().replace(
      decoration("info", INFO),
      `@extension("${EXTENSION_KEY}", duration.fromISO("nonsense"))`,
    );
    const { diagnostics, doc } = await compile(source);
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "tsp-azure-service-bus/profile-shape" &&
          diagnostic.severity === "error",
      ),
    ).toBe(true);
    expect(doc).toBeUndefined();
  });

  it("does not invent inherited message header metadata for a runtime location", async () => {
    const source = contract({
      extra: `@jsonSchemaExtension("additionalProperties", false) model AppProperties { requestId: string; }
        @headers(AppProperties) model Base { payload: string; }`,
      messageDecorators: '@correlationId("$message.header#/requestId")',
    }).replace("model Command {", "model Command extends Base {");
    const { diagnostics, doc } = await compile(source);
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.code === "tsp-azure-service-bus/runtime-location",
      ),
    ).toBe(true);
    expect(doc).toBeUndefined();
  });

  it("rejects payload schema overrides even without native-property declarations", async () => {
    await rejected(
      {
        message: { ...VERSION, target: "message" },
        operation: { ...VERSION, target: "operation", action: "send" },
        messageDecorators: '@jsonSchemaExtension("type", "array")',
      },
      "profile-unsupported",
    );
  });

  it("packages exactly the authoritative schema and writes values that conform to it", async () => {
    const authoritative = JSON.parse(
      await readFile(
        new URL("docs/public/profiles/azure-service-bus/0.1.0/schema.json", ROOT),
        "utf8",
      ),
    ) as object;
    const packaged = JSON.parse(
      await readFile(new URL("packages/tsp-azure-service-bus/schema/0.1.0.json", ROOT), "utf8"),
    ) as object;
    expect(packaged).toEqual(authoritative);
    const validate = new Ajv({ strict: false }).compile(packaged);
    const { doc } = await compile(contract());
    if (!doc) throw new Error("Missing document.");
    for (const profile of [
      doc.info[EXTENSION_KEY],
      channelsOf(doc).Commands[EXTENSION_KEY],
      messagesOf(doc).Command[EXTENSION_KEY],
      operationsOf(doc).execute[EXTENSION_KEY],
    ]) {
      expect(validate(profile), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("returns copies without adding omitted fields or mutating core state", async () => {
    const { result } = await compile(
      contract({
        message: { ...VERSION, target: "message" },
        operation: { ...VERSION, target: "operation", action: "send" },
      }),
    );
    const namespace = result.program.getGlobalNamespaceType().namespaces.get("App");
    const model = namespace?.models.get("Command");
    if (!model) throw new Error("Missing test model.");
    expect(getProfile(result.program, model)).toEqual({ ...VERSION, target: "message" });
    const first = getProfile(result.program, model);
    if (!first) throw new Error("Missing profile.");
    Object.assign(first, { nativeProperties: { MessageId: { required: true } } });
    expect(getProfile(result.program, model)).not.toHaveProperty("nativeProperties");
    expect(getExtensions(result.program, model).get(EXTENSION_KEY)).not.toHaveProperty(
      "nativeProperties",
    );
  });

  it.each([
    ["profile version", { message: { ...MESSAGE, profileVersion: "0.2.0" } }, "profile-shape"],
    ["unknown guarantee", { message: { ...MESSAGE, exactlyOnce: true } }, "profile-shape"],
    ["wrong discriminator", { message: { ...MESSAGE, target: "channel" } }, "profile-placement"],
    ["unmarked message", { markMessage: false }, "profile-placement"],
    ["info AsyncAPI version", { info: { ...INFO, asyncapiVersion: "3.0.0" } }, "profile-shape"],
    [
      "missing subscription parent",
      { channel: { ...CHANNEL, entity: { kind: "subscription", id: "orders.sub" } } },
      "profile-shape",
    ],
    [
      "session on topic",
      {
        channel: {
          ...CHANNEL,
          entity: { kind: "topic", id: "orders.topic" },
          deploymentRequirements: { sessions: true },
        },
      },
      "deployment-incompatible",
    ],
    [
      "duplicate detection on subscription",
      {
        channel: {
          ...CHANNEL,
          entity: { kind: "subscription", id: "orders.sub", topicId: "orders.topic" },
          deploymentRequirements: {
            partitioning: "disabled",
            duplicateDetection: { required: true, scope: "messageId" },
          },
        },
      },
      "deployment-incompatible",
    ],
    [
      "bad duplicate window",
      {
        channel: {
          ...CHANNEL,
          deploymentRequirements: {
            partitioning: "disabled",
            duplicateDetection: { required: true, scope: "messageId", historyWindowSeconds: 19 },
          },
        },
      },
      "deployment-incompatible",
    ],
    [
      "too long lock",
      { channel: { ...CHANNEL, deploymentRequirements: { lockDurationSeconds: 301 } } },
      "deployment-incompatible",
    ],
    [
      "partitioned dedup scope",
      { channel: { ...CHANNEL, deploymentRequirements: { partitioning: "enabled" } } },
      "profile-unsupported",
    ],
    [
      "read-only native field",
      { message: { ...MESSAGE, nativeProperties: { DeliveryCount: { required: true } } } },
      "native-metadata",
    ],
    [
      "native metadata extraction DSL",
      {
        message: {
          ...MESSAGE,
          nativeProperties: { MessageId: { required: true, source: "$message.payload#/id" } },
        },
      },
      "native-metadata",
    ],
    [
      "native ID length",
      {
        message: {
          ...MESSAGE,
          nativeProperties: { MessageId: { required: true, const: "x".repeat(129) } },
        },
      },
      "profile-shape",
    ],
    [
      "native literal vs maxLength",
      {
        message: {
          ...MESSAGE,
          nativeProperties: { MessageId: { required: true, const: "123", maxLength: 2 } },
        },
      },
      "profile-shape",
    ],
    [
      "second ContentType",
      {
        message: {
          ...MESSAGE,
          nativeProperties: { ContentType: { required: true, const: "application/json" } },
        },
      },
      "native-metadata",
    ],
    [
      "send receive mode",
      { operation: { ...SEND, deliveryRequirements: { receiveMode: "peekLock" } } },
      "delivery-conflict",
    ],
    [
      "ReceiveAndDelete settlement",
      {
        action: "receive" as const,
        operation: { ...RECEIVE, deliveryRequirements: { receiveMode: "receiveAndDelete" } },
      },
      "delivery-conflict",
    ],
    [
      "incomplete PeekLock",
      {
        action: "receive" as const,
        operation: { ...RECEIVE, applicationObligations: { idempotency: "required" } },
      },
      "delivery-conflict",
    ],
    [
      "TLS disabled",
      { operation: { ...SEND, authorizationRequirements: { tls: false } } },
      "profile-shape",
    ],
  ])("rejects %s with a source-targeted diagnostic", async (_name, options, code) => {
    const { matching } = await rejected({ ...options, raw: true }, code);
    expect(targetText(matching[0])).not.toBe("");
  });

  it.each([
    [
      "send subscription",
      {
        channel: {
          ...CHANNEL,
          entity: { kind: "subscription", id: "orders.sub", topicId: "orders.topic" },
        },
      },
      "entity-direction",
    ],
    [
      "receive topic",
      {
        action: "receive" as const,
        operation: RECEIVE,
        channel: { ...CHANNEL, entity: { kind: "topic", id: "orders.topic" } },
      },
      "entity-direction",
    ],
    [
      "action disagreement",
      { operation: { ...VERSION, target: "operation", action: "receive" } },
      "profile-conflict",
    ],
    [
      "Basic session",
      {
        channel: {
          ...CHANNEL,
          deploymentRequirements: { sessions: true, allowedTiers: ["basic"] },
        },
      },
      "deployment-incompatible",
    ],
    [
      "Basic TTL",
      {
        channel: {
          ...CHANNEL,
          deploymentRequirements: { allowedTiers: ["basic"], defaultTtlSeconds: 1209601 },
        },
      },
      "deployment-incompatible",
    ],
    [
      "session metadata absent",
      { channel: { ...CHANNEL, deploymentRequirements: { sessions: true } } },
      "native-metadata",
    ],
    [
      "session ordering without capability",
      {
        action: "receive" as const,
        operation: {
          ...RECEIVE,
          deliveryRequirements: { receiveMode: "peekLock", order: "perSession" },
          applicationObligations: {
            ...RECEIVE.applicationObligations,
            sessionProcessing: "serial",
          },
        },
      },
      "delivery-conflict",
    ],
    [
      "TTL capped",
      {
        channel: { ...CHANNEL, deploymentRequirements: { defaultTtlSeconds: 30 } },
        message: { ...MESSAGE, ttlSeconds: 31 },
      },
      "deployment-incompatible",
    ],
    [
      "dedup identity missing",
      {
        channel: {
          ...CHANNEL,
          deploymentRequirements: {
            partitioning: "disabled",
            duplicateDetection: { required: true, scope: "messageId" },
          },
        },
        operation: { ...VERSION, target: "operation", action: "send" },
      },
      "delivery-conflict",
    ],
    [
      "self parent",
      {
        channel: {
          ...CHANNEL,
          entity: { kind: "subscription", id: "orders.sub", topicId: "orders.sub" },
        },
      },
      "topology-conflict",
    ],
  ])("diagnoses relational %s", async (_name, options, code) => {
    await rejected(options, code);
  });

  it.each(["amqp", "kafka", "amqp1"])("rejects incompatible %s bindings", async (protocol) => {
    await rejected(
      { channelDecorators: `@binding("${protocol}", #{bindingVersion: "0.1.0"})` },
      "transport-conflict",
    );
  });

  it("accepts an explicitly empty amqp1 binding and TLS composition", async () => {
    const { diagnostics, doc } = await compile(
      contract({
        channelDecorators: `@binding("amqp1", #{}) @useServer("test")`,
        serviceDecorators: `@server("test", #{host: "example.servicebus.windows.net", protocol: "amqps", protocolVersion: "1.0"})`,
        operation: { ...SEND, authorizationRequirements: { tls: true, authentication: "entraId" } },
      }),
    );
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    await expect(doc).toBeValidAsyncAPI();
  });

  it("rejects incompatible server protocol or server binding", async () => {
    await rejected(
      {
        serviceDecorators: `@server("test", #{host:"example.invalid", protocol:"amqp", protocolVersion:"0.9.1"})`,
      },
      "transport-conflict",
    );
    await rejected(
      {
        serviceDecorators: `@server("test", #{host:"example.invalid", protocol:"amqps"}) @binding("amqp1", #{bindingVersion:"0.1.0"})`,
      },
      "transport-conflict",
    );
  });

  it.each([false, true])(
    "rejects typed/raw collisions regardless of declaration order (%s)",
    async (reverse) => {
      const raw = decoration("message", MESSAGE, true);
      const typed = decoration("message", MESSAGE);
      const source = contract().replace(typed, reverse ? `${raw}\n${typed}` : `${typed}\n${raw}`);
      const { diagnostics, doc } = await compile(source);
      expect(
        diagnostics.some(
          (diagnostic) => diagnostic.code === "tsp-azure-service-bus/profile-conflict",
        ),
      ).toBe(true);
      expect(doc).toBeUndefined();
    },
  );

  it("rejects repeated typed declarations and misplaced raw profiles", async () => {
    await rejected({ messageDecorators: decoration("message", MESSAGE) }, "profile-conflict");
    await rejected(
      { body: `${decoration("message", MESSAGE, true)} id: string;` },
      "profile-placement",
    );
    await rejected({ serviceDecorators: "@dynamicChannel" }, "profile-placement");
  });

  it("rejects versioned, dependency-mutated and multi-service claims explicitly", async () => {
    await rejected(
      { extra: `enum Versions { v1: "v1", v2: "v2" } @@versioned(App, Versions);` },
      "profile-unsupported",
    );
    await rejected(
      {
        beforeService: `@versioned(Versions) namespace Dependency { enum Versions { v1: "v1" } model Item { id: string; } }`,
        serviceDecorators: "@useDependency(Dependency.Versions.v1)",
      },
      "profile-unsupported",
    );
    await rejected({ extra: `@service namespace Another {}` }, "profile-unsupported");
  });

  it.each([
    ["open headers", "model Headers { id: string; }"],
    [
      "nested property",
      `@jsonSchemaExtension("additionalProperties", false) model Headers { id: { value: string }; }`,
    ],
    [
      "nullable property",
      `@jsonSchemaExtension("additionalProperties", false) model Headers { id: string | null; }`,
    ],
    [
      "unsafe integer",
      `@jsonSchemaExtension("additionalProperties", false) model Headers { id: int64; }`,
    ],
    [
      "binary property",
      `@jsonSchemaExtension("additionalProperties", false) model Headers { id: bytes; }`,
    ],
    [
      "raw scalar override",
      `@jsonSchemaExtension("additionalProperties", false) model Headers { @jsonSchemaExtension("type", "object") id: string; }`,
    ],
    [
      "decimal application property",
      `@jsonSchemaExtension("additionalProperties", false) model Headers { amount: decimal; }`,
    ],
    [
      "numeric enum application property",
      `enum Numeric { one: 1 } @jsonSchemaExtension("additionalProperties", false) model Headers { value: Numeric; }`,
    ],
    [
      "encoded binary application property",
      `@jsonSchemaExtension("additionalProperties", false) model Headers { @encode("base64") data: bytes; }`,
    ],
    [
      "inherited application-property model",
      `model Base { id: string; } @jsonSchemaExtension("additionalProperties", false) model Headers extends Base { extra: string; }`,
    ],
    [
      "indexed application-property model",
      `@jsonSchemaExtension("additionalProperties", false) model Headers is Record<string>;`,
    ],
    [
      "duplicate application-property wire names",
      `@jsonSchemaExtension("additionalProperties", false) model Headers { @encodedName("application/json", "id") first: string; @encodedName("application/json", "id") second: string; }`,
    ],
  ])("rejects %s", async (_name, extra) => {
    await rejected({ extra, messageDecorators: "@headers(Headers)" }, "application-properties");
  });

  it("rejects raw payload/header schemas and open lifted headers", async () => {
    await rejected(
      {
        messageDecorators: `@rawPayload("application/schema+json;version=draft-07", #{type:"object"})`,
      },
      "profile-unsupported",
    );
    await rejected(
      {
        messageDecorators: `@rawHeaders("application/schema+json;version=draft-07", #{type:"object"})`,
      },
      "profile-unsupported",
    );
    await rejected({ body: "@header requestId: string; id: string;" }, "application-properties");
    await rejected(
      { messageDecorators: `@jsonSchemaExtension("properties", #{different: #{type:"string"}})` },
      "profile-unsupported",
    );
    await rejected(
      { body: `@jsonSchemaExtension("type", "object") id: string;` },
      "profile-unsupported",
    );
  });

  it("requires explicit native ContentType and rejects binary content", async () => {
    const absent = await compile(contract().replace('@contentType("application/json")', ""));
    expect(
      absent.diagnostics.some(
        (diagnostic) => diagnostic.code === "tsp-azure-service-bus/native-metadata",
      ),
    ).toBe(true);
    expect(absent.doc).toBeUndefined();
    const binary = await compile(
      contract().replace('@contentType("application/json")', '@contentType("application/avro")'),
    );
    expect(
      binary.diagnostics.some(
        (diagnostic) => diagnostic.code === "tsp-azure-service-bus/profile-unsupported",
      ),
    ).toBe(true);
    expect(binary.doc).toBeUndefined();
  });

  it("rejects an unowned action that references a profiled message", async () => {
    await rejected({ extra: "@send op outside(command: Command): void;" }, "profile-placement");
  });

  it("does not affect broker-neutral documents that merely import the companion", async () => {
    const { diagnostics, doc } = await compile(`
      @service namespace Plain;
      @message model Event { id: string; }
      @channel("events") interface Events { @send op publish(event: Event): void; }
    `);
    expect(diagnostics).toEqual([]);
    await expect(doc).toBeValidAsyncAPI();
    expect(doc?.info).not.toHaveProperty(EXTENSION_KEY);
  });

  it("keeps source-order profile aggregation stable for reopened namespaces", async () => {
    const info = decoration("info", INFO)
      .replace("@infoProfile", "@@infoProfile")
      .replace("(", "(App,");
    const { diagnostics } = await compile(`
      @service namespace App {}
      namespace App {}
      ${info};
    `);
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.code === "tsp-azure-service-bus/deployment-unverified",
      ),
    ).toHaveLength(1);
  });

  it("uses standard SASL PLAIN without accepting fake HTTP bearer/CBS mappings", async () => {
    const sas = await compile(
      contract({
        serviceDecorators: `@securityScheme("sas", #{type:"plain"})`,
        operationDecorators: `@useSecurity("sas")`,
        operation: { ...SEND, authorizationRequirements: { tls: true, authentication: "sas" } },
      }),
    );
    expect(sas.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    await expect(sas.doc).toBeValidAsyncAPI();
    await rejected(
      {
        serviceDecorators: `@securityScheme("http", #{type:"http", scheme:"bearer"})`,
        operationDecorators: `@useSecurity("http")`,
      },
      "profile-unsupported",
    );
    await rejected(
      {
        serviceDecorators: `@securityScheme("sas", #{type:"plain"})`,
        operationDecorators: `@useSecurity("sas")`,
        operation: { ...SEND, authorizationRequirements: { tls: true, authentication: "entraId" } },
      },
      "transport-conflict",
    );
  });

  it("validates server-selected OAuth2 client credentials against operation authentication", async () => {
    const options: Options = {
      serviceDecorators: `
        @server("composed", #{host: "example.servicebus.windows.net", protocol: "amqps"})
        @securityScheme("entra", #{
          type: "oauth2",
          flows: #{clientCredentials: #{
            tokenUrl: "https://identity.example.invalid/token",
            availableScopes: #{}
          }}
        })
        @useSecurity("entra")
      `,
      operation: { ...SEND, authorizationRequirements: { tls: true, authentication: "entraId" } },
    };
    const { diagnostics, doc } = await compile(contract(options));
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    await expect(doc).toBeValidAsyncAPI();
    expect(doc).toHaveProperty("servers.composed.security", [
      { $ref: "#/components/securitySchemes/entra" },
    ]);
    expect(doc).toHaveProperty(
      "components.securitySchemes.entra.flows.clientCredentials.tokenUrl",
      "https://identity.example.invalid/token",
    );
    await rejected(
      {
        ...options,
        operation: { ...SEND, authorizationRequirements: { tls: true, authentication: "sas" } },
      },
      "transport-conflict",
    );
  });

  it("rejects an undeclared operation security reference before emission", async () => {
    const { matching } = await rejected(
      { operationDecorators: '@useSecurity("missing")' },
      "transport-conflict",
    );
    expect(matching[0].message).toContain("Security scheme 'missing' is not declared.");
  });

  it.each(["send", "receive"] as const)(
    "keeps OR security groups separate for %s and its reply",
    async (action) => {
      const options = replyOptions();
      const { diagnostics, doc } = await compile(
        contract({
          ...options,
          action,
          operation: {
            ...(action === "send" ? SEND : RECEIVE),
            authorizationRequirements: { tls: true, authentication: "entraId" },
            nativeReply: {
              address: "fixedChannel",
              correlation: "requestMessageId",
              session: "requestReplyToSessionId",
            },
          },
          serviceDecorators: `${securityDefinitions}
        @server("primary", #{host: "primary.example.invalid", protocol: "amqps"})
        @server("responses", #{host: "responses.example.invalid", protocol: "amqps"})
        @useSecurity("sas") @useSecurity("entra")`,
          channelDecorators: '@useServer("primary")',
          operationDecorators: '@replyChannel(Replies) @useSecurity("entra")',
          extra: `${options.extra}\n@@useServer(Replies, "responses");`,
        }),
      );
      expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      await expect(doc).toBeValidAsyncAPI();
      for (const server of ["primary", "responses"]) {
        expect(doc).toHaveProperty(`servers.${server}.security`, [
          { $ref: "#/components/securitySchemes/sas" },
          { $ref: "#/components/securitySchemes/entra" },
        ]);
      }
      expect(doc).toHaveProperty("operations.execute.security", [
        { $ref: "#/components/securitySchemes/entra" },
      ]);
      expect(doc).toHaveProperty("channels.Commands.servers", [{ $ref: "#/servers/primary" }]);
      expect(doc).toHaveProperty("channels.Replies.servers", [{ $ref: "#/servers/responses" }]);
    },
  );

  it.each([
    ["server", '@useSecurity("sas")', '@useSecurity("entra")', "transport-conflict"],
    [
      "operation",
      '@useSecurity("sas") @useSecurity("entra")',
      '@useSecurity("sas")',
      "transport-conflict",
    ],
    [
      "unsupported operation",
      '@useSecurity("entra")',
      '@useSecurity("http")',
      "profile-unsupported",
    ],
    [
      "unknown server alternative",
      '@useSecurity("entra") @useSecurity("missing")',
      '@useSecurity("entra")',
      "transport-conflict",
    ],
  ])(
    "rejects a required %s security group without a usable choice",
    async (_label, serverSecurity, operationSecurity, code) => {
      await rejected(
        {
          serviceDecorators: `${securityDefinitions} @server("broker", #{host: "example.invalid", protocol: "amqps"}) ${serverSecurity}`,
          operationDecorators: operationSecurity,
          operation: {
            ...SEND,
            authorizationRequirements: { tls: true, authentication: "entraId" },
          },
        },
        code,
      );
    },
  );

  it("does not require unsupported or differently authenticated alternatives when a compatible choice exists", async () => {
    const { diagnostics, doc } = await compile(
      contract({
        serviceDecorators: `${securityDefinitions} @server("broker", #{host: "example.invalid", protocol: "amqps"}) @useSecurity("http") @useSecurity("sas") @useSecurity("entra")`,
        operationDecorators: '@useSecurity("sas") @useSecurity("entra")',
        operation: { ...SEND, authorizationRequirements: { tls: true, authentication: "sas" } },
      }),
    );
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    await expect(doc).toBeValidAsyncAPI();
  });

  it("accepts explicit same-named application mirrors using encoded wire names and escaped pointers", async () => {
    const { diagnostics, doc } = await compile(
      contract({
        extra: `@jsonSchemaExtension("additionalProperties", false) model Headers { @encodedName("application/json", "Correlation/Id") CorrelationId: string; }`,
        messageDecorators: `@headers(Headers) @correlationId("$message.header#/Correlation~1Id")`,
        message: {
          ...MESSAGE,
          nativeProperties: { ...MESSAGE.nativeProperties, CorrelationId: { required: true } },
        },
      }),
    );
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    await expect(doc).toBeValidAsyncAPI();
  });

  it("rejects fake native pointers, optional locations and payload/header confusion", async () => {
    await rejected(
      { messageDecorators: `@correlationId("$message.header#/CorrelationId")` },
      "runtime-location",
    );
    await rejected(
      { body: "id?: string;", messageDecorators: `@correlationId("$message.payload#/id")` },
      "runtime-location",
    );
    await rejected(
      { body: "@header id: string;", messageDecorators: `@correlationId("$message.payload#/id")` },
      "runtime-location",
    );
    await rejected(
      {
        body: "@invisible(Lifecycle) id: string;",
        messageDecorators: `@correlationId("$message.payload#/id")`,
      },
      "runtime-location",
    );
  });

  it.each([
    "union Identifier { text: string, recursive: Identifier }",
    "union Identifier { text: string, other: Mutual } union Mutual { number: int32, recursive: Identifier }",
  ])("diagnoses recursive runtime-location unions instead of crashing: %s", async (extra) => {
    const options = {
      extra,
      body: "id: Identifier;",
      messageDecorators: '@correlationId("$message.payload#/id")',
    };
    const { matching } = await rejected(options, "runtime-location");
    expect(matching[0].message).toContain("recursive union");
    let control = contract(options);
    for (const [target, profile] of [
      ["info", INFO],
      ["message", MESSAGE],
      ["channel", CHANNEL],
      ["operation", SEND],
    ] as const) {
      control = control.replace(decoration(target, profile), "");
    }
    const { diagnostics, doc } = await compile(control);
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    await expect(doc).toBeValidAsyncAPI();
    expect(doc).toHaveProperty(
      "components.messages.Command.correlationId.location",
      "$message.payload#/id",
    );
  });

  it("accepts acyclic unions sharing scalar union branches", async () => {
    const { diagnostics, doc } = await compile(
      contract({
        extra: `union Shared { text: string, flag: boolean }
        union Left { shared: Shared, number: int32 }
        union Right { shared: Shared, literal: "fixed" }
        union Identifier { left: Left, right: Right }`,
        body: "id: Identifier;",
        messageDecorators: '@correlationId("$message.payload#/id")',
      }),
    );
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    await expect(doc).toBeValidAsyncAPI();
  });

  it.each([20, 604800])(
    "accepts duplicate-detection window boundary %s without other defaults",
    async (historyWindowSeconds) => {
      const { diagnostics, doc } = await compile(
        contract({
          channel: {
            ...CHANNEL,
            deploymentRequirements: {
              partitioning: "disabled",
              duplicateDetection: { required: true, scope: "messageId", historyWindowSeconds },
            },
          },
        }),
      );
      expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      expect(doc).toBeDefined();
    },
  );

  it("accepts explicit ReceiveAndDelete loss and session-ordered PeekLock", async () => {
    const lossy = await compile(
      contract({
        action: "receive",
        operation: {
          ...VERSION,
          target: "operation",
          action: "receive",
          deliveryRequirements: { receiveMode: "receiveAndDelete" },
          applicationObligations: { loss: "accepted", failureHandling: "applicationRecovery" },
        },
      }),
    );
    expect(lossy.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const sessions = await compile(
      contract({
        action: "receive",
        channel: { ...CHANNEL, deploymentRequirements: { sessions: true } },
        message: {
          ...MESSAGE,
          nativeProperties: { ...MESSAGE.nativeProperties, SessionId: { required: true } },
        },
        operation: {
          ...RECEIVE,
          deliveryRequirements: { receiveMode: "peekLock", order: "perSession" },
          applicationObligations: {
            ...RECEIVE.applicationObligations,
            sessionProcessing: "serial",
          },
        },
      }),
    );
    expect(sessions.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual(
      [],
    );
  });

  it.each([
    "docs/reference/service-bus.md",
    "docs/zh-tw/reference/service-bus.md",
    "packages/tsp-azure-service-bus/README.md",
    "packages/tsp-azure-service-bus/README.zh-TW.md",
  ])("compiles the complete examples in %s", async (path) => {
    const markdown = await readFile(new URL(path, ROOT), "utf8");
    const snippets = [...markdown.matchAll(/```typespec\n([\s\S]*?)```/gu)];
    expect(snippets.length).toBeGreaterThan(0);
    for (const snippet of snippets) {
      const source = snippet[1]
        .replace(/^import "(?:tsp-asyncapi|tsp-azure-service-bus)";\n/gmu, "")
        .replace(/^using (?:AsyncAPI|Azure.ServiceBus);\n/gmu, "");
      const { diagnostics, doc } = await compile(source);
      expect(
        diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
      ).toEqual([]);
      await expect(doc).toBeValidAsyncAPI();
    }
  });
});

const securityDefinitions = `
  @securityScheme("sas", #{type: "plain"})
  @securityScheme("entra", #{type: "oauth2", flows: #{clientCredentials: #{
    tokenUrl: "https://identity.example.invalid/token", availableScopes: #{}
  }}})
  @securityScheme("http", #{type: "http", scheme: "bearer"})
`;

function replyOptions(
  address: "fixedChannel" | "requestReplyTo" = "fixedChannel",
  overrides: { readonly request?: NativeProperties; readonly reply?: NativeProperties } = {},
): Options & { readonly extra: string } {
  return {
    message: {
      ...MESSAGE,
      nativeProperties: {
        ...MESSAGE.nativeProperties,
        ReplyTo: { required: true },
        ReplyToSessionId: { required: true },
        ...overrides.request,
      },
    },
    operation: {
      ...SEND,
      nativeReply: { address, correlation: "requestMessageId", session: "requestReplyToSessionId" },
    },
    returnType: "Result",
    operationDecorators: "@replyChannel(Replies)",
    extra: `
      @message @contentType("application/json")
      ${decoration("message", { ...MESSAGE, nativeProperties: { ...MESSAGE.nativeProperties, CorrelationId: { required: true }, SessionId: { required: true }, ...overrides.reply } })}
      model Result { id: string; }
      @dynamicChannel
      ${decoration("channel", { ...CHANNEL, entity: { kind: "queue", id: "orders.replies" }, deploymentRequirements: { sessions: true } })}
      interface Replies {}
    `,
  };
}

function copyOptions(source: NativeString, destination: NativeString, session: boolean): Options {
  return replyOptions("fixedChannel", {
    request: session ? { ReplyToSessionId: source } : { MessageId: source },
    reply: session ? { SessionId: destination } : { CorrelationId: destination },
  });
}

describe("Service Bus: replies and topology", () => {
  it.each([
    [
      "correlation constants",
      { required: true, const: "a" },
      { required: true, const: "b" },
      false,
    ],
    [
      "correlation destination length",
      { required: true, const: "123" },
      { required: true, maxLength: 2 },
      false,
    ],
    [
      "correlation source length",
      { required: true, maxLength: 2 },
      { required: true, const: "123" },
      false,
    ],
    [
      "implicit source ID ceiling",
      { required: true },
      { required: true, const: "x".repeat(129) },
      false,
    ],
    ["session constants", { required: true, const: "a" }, { required: true, const: "b" }, true],
    [
      "session destination length",
      { required: true, const: "123" },
      { required: true, maxLength: 2 },
      true,
    ],
    [
      "session source length",
      { required: true, maxLength: 2 },
      { required: true, const: "123" },
      true,
    ],
  ] as const)("rejects impossible native copy %s", async (_label, source, destination, session) => {
    const { matching } = await rejected(
      copyOptions(source, destination, session),
      "reply-conflict",
    );
    expect(matching[0].message).toContain("copy constraints");
    expect(targetText(matching[0])).toContain("nativeReply");
  });

  it.each([
    [
      { required: true, const: "a" },
      { required: true, const: "a" },
    ],
    [
      { required: true, const: "123" },
      { required: true, maxLength: 3 },
    ],
    [
      { required: true, maxLength: 3 },
      { required: true, const: "123" },
    ],
    [
      { required: true, maxLength: 3 },
      { required: true, maxLength: 2 },
    ],
    [{ required: true }, { required: true, const: "x".repeat(128) }],
    [
      { required: true, const: "\u{1f600}", maxLength: 1 },
      { required: true, maxLength: 1 },
    ],
  ] as const)(
    "accepts compatible correlation and session copy constraints %j -> %j",
    async (source, destination) => {
      for (const session of [false, true]) {
        const { diagnostics, doc } = await compile(
          contract(copyOptions(source, destination, session)),
        );
        expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
        await expect(doc).toBeValidAsyncAPI();
      }
    },
  );

  it("checks native copy constraints on processor replies, but not an undeclared copy relation", async () => {
    const options = copyOptions(
      { required: true, const: "a" },
      { required: true, const: "b" },
      false,
    );
    await rejected(
      {
        ...options,
        action: "receive",
        operation: {
          ...RECEIVE,
          nativeReply: { address: "fixedChannel", correlation: "requestMessageId" },
        },
      },
      "reply-conflict",
    );
    const { diagnostics, doc } = await compile(contract({ ...options, operation: SEND }));
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    await expect(doc).toBeValidAsyncAPI();
  });

  it.each([false, true])(
    "requires a jointly compatible counterpart for message variants (crossed sessions=%s)",
    async (crossed) => {
      const options = replyOptions("fixedChannel", {
        request: {
          MessageId: { required: true, const: "a" },
          ReplyToSessionId: { required: true, const: "a" },
        },
        reply: {
          CorrelationId: { required: true, const: "a" },
          SessionId: { required: true, const: crossed ? "b" : "a" },
        },
      });
      const source = contract({
        ...options,
        returnType: "Result | ResultB",
        extra: `${options.extra}
        @message @contentType("application/json")
        ${decoration("message", { ...MESSAGE, nativeProperties: { ...MESSAGE.nativeProperties, MessageId: { required: true, const: "b" }, ReplyToSessionId: { required: true, const: "b" } } })}
        model CommandB { id: string; }
        @message @contentType("application/json")
        ${decoration("message", { ...MESSAGE, nativeProperties: { ...MESSAGE.nativeProperties, CorrelationId: { required: true, const: "b" }, SessionId: { required: true, const: crossed ? "a" : "b" } } })}
        model ResultB { id: string; }
      `,
      }).replace("command: Command", "command: Command | CommandB");
      const { diagnostics, doc } = await compile(source);
      if (crossed) {
        expect(
          diagnostics.some(
            (diagnostic) => diagnostic.code === "tsp-azure-service-bus/reply-conflict",
          ),
        ).toBe(true);
        expect(doc).toBeUndefined();
      } else {
        expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
        await expect(doc).toBeValidAsyncAPI();
      }
    },
  );

  it.each(["fixedChannel", "requestReplyTo"] as const)(
    "preserves standard reply refs with native %s obligations",
    async (address) => {
      const { diagnostics, doc } = await compile(contract(replyOptions(address)));
      expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      await expect(doc).toBeValidAsyncAPI();
      if (!doc) throw new Error("Missing document.");
      expect(operationsOf(doc).execute.reply).toHaveProperty("channel.$ref", "#/channels/Replies");
      expect(operationsOf(doc).execute.reply).not.toHaveProperty("address");
      expect(messagesOf(doc).Result.correlationId).toBeUndefined();
    },
  );

  it("requires explicit reply channel, messages, native correlation and session capability", async () => {
    await rejected({ ...replyOptions(), operationDecorators: "" }, "reply-conflict");
    await rejected({ ...replyOptions(), returnType: "void" }, "reply-conflict");
    await rejected({ ...replyOptions(), message: MESSAGE }, "native-metadata");
    const options = replyOptions();
    await rejected(
      { ...options, extra: options.extra.replace("`sessions`: true", "`sessions`: false") },
      "reply-conflict",
    );
    await rejected(
      {
        ...options,
        operationDecorators: `@replyChannel(Replies) @replyAddress("$message.payload#/id")`,
      },
      "reply-conflict",
    );
  });

  it("requires a null address for native dynamic reply routing", async () => {
    const options = replyOptions("requestReplyTo");
    await rejected(
      {
        ...options,
        extra: options.extra.replace("@dynamicChannel", '@channel("composed.replies")'),
      },
      "reply-conflict",
    );
  });

  it("validates receive/request and send/reply from the processor perspective", async () => {
    const options = {
      ...replyOptions(),
      operation: {
        ...RECEIVE,
        nativeReply: {
          address: "fixedChannel",
          correlation: "requestMessageId",
          session: "requestReplyToSessionId",
        },
      },
    };
    const source = contract(options)
      .replace("@send", "@receive")
      .replace("op execute(command: Command): Result;", "op execute(result: Result): Command;");
    const { diagnostics, doc } = await compile(source);
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    if (!doc) throw new Error("Missing processor document.");
    expect(operationsOf(doc).execute.action).toBe("receive");
    expect(operationsOf(doc).execute.messages).toEqual([
      { $ref: "#/channels/Commands/messages/Command" },
    ]);
    expect(operationsOf(doc).execute.reply?.messages).toEqual([
      { $ref: "#/channels/Replies/messages/Result" },
    ]);
  });

  it("requires an explicit identity-bearing send for duplicate-detected reply traffic", async () => {
    const options = replyOptions();
    const source = contract({
      ...options,
      extra: options.extra.replace(
        "`sessions`: true",
        '`sessions`: true, `partitioning`: "disabled", `duplicateDetection`: #{ required: true, scope: "messageId" }',
      ),
      operation: {
        ...RECEIVE,
        nativeReply: {
          address: "fixedChannel",
          correlation: "requestMessageId",
          session: "requestReplyToSessionId",
        },
      },
    })
      .replace("@send", "@receive")
      .replace("op execute(command: Command): Result;", "op execute(result: Result): Command;");
    const missing = await compile(source);
    expect(
      missing.diagnostics.some(
        (diagnostic) => diagnostic.code === "tsp-azure-service-bus/delivery-conflict",
      ),
    ).toBe(true);
    expect(missing.doc).toBeUndefined();
    const complete = await compile(
      source.replace(
        "interface Replies {}",
        `interface Replies {
      @send ${decoration("operation", SEND)} op sendResult(result: Result): void;
    }`,
      ),
    );
    expect(complete.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual(
      [],
    );
    await expect(complete.doc).toBeValidAsyncAPI();
  });

  it("accepts external subscription parent relations and reports them as unverified", async () => {
    const { diagnostics } = await compile(
      contract({
        action: "receive",
        operation: RECEIVE,
        channel: {
          ...CHANNEL,
          entity: { kind: "subscription", id: "orders.fulfillment", topicId: "orders.events" },
        },
      }),
    );
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(
      diagnostics.find((diagnostic) => diagnostic.code.endsWith("deployment-unverified"))?.message,
    ).toContain("orders.events");
  });

  it.each([
    { kind: "topic", id: "orders.commands" },
    { kind: "subscription", id: "orders.commands", topicId: "orders.other" },
  ])("rejects conflicting entity identity $kind", async (entity) => {
    await rejected(
      {
        extra: `@dynamicChannel ${decoration("channel", { ...CHANNEL, entity })} interface Other {}`,
      },
      "topology-conflict",
    );
  });

  it("intersects alias requirements and rejects contradictions", async () => {
    await rejected(
      {
        channel: {
          ...CHANNEL,
          deploymentRequirements: { sessions: true, allowedTiers: ["premium"] },
        },
        extra: `@dynamicChannel ${decoration("channel", { ...CHANNEL, deploymentRequirements: { sessions: false, allowedTiers: ["standard"] } })} interface Other {}`,
      },
      "topology-conflict",
    );
  });
});
