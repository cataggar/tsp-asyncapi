import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import { EXTENSION_KEY, NATIVE_PROPERTY_MAPPINGS } from "tsp-azure-service-bus";
import type { MessageProfile, NativeProperties, NativeString } from "tsp-azure-service-bus/types";
import type { AsyncAPIDocument, MessageObject } from "#emitter/types/index.js";
import { messagesOf, channelsOf } from "../utils/document.js";
import { resolveRef } from "../utils/json-pointer.js";
import { compileOpenAPI31Schema } from "../utils/openapi-validation.js";
import { INTEROPERABILITY_ROOT } from "../utils/interoperability-generation.js";

interface Order {
  orderId: string;
  customerId: string;
  items: { sku: string; quantity: number }[];
}
interface Envelope<T> {
  amqpHeader: { ttl: number };
  native: Record<string, string>;
  headers: Record<string, string>;
  payload: T;
}
interface Flow {
  http: {
    idempotencyKey: string;
    request: Order;
    accepted: { commandId: string; orderId: string; state: string };
  };
  command: Envelope<{ commandId: string; expiresAt: string; order: Order }>;
  event: Envelope<{ eventId: string; occurredAt: string; expiresAt: string; order: Order }>;
  result: Envelope<{
    commandId: string;
    orderId: string;
    outcome: string;
    reason?: string;
    expiresAt: string;
  }>;
}
function read(file: string): unknown {
  return JSON.parse(readFileSync(join(INTEROPERABILITY_ROOT, file), "utf8"));
}
const FLOW = read("fixtures/flow.json") as Flow;
const INVALID = read("fixtures/invalid-orders.json") as {
  name: string;
  keyword: string;
  order: unknown;
}[];
const GATEWAY = read("asyncapi.json") as AsyncAPIDocument;
const PROCESSOR = read("processor/asyncapi.json") as AsyncAPIDocument;
const FULFILLMENT = read("fulfillment/asyncapi.json") as AsyncAPIDocument;
const HTTP = read("http/openapi.json");

// Deliberately scoped to this example's native Draft-07 subset, not a fidelity
// framework. Fail if generated schemas grow outside the supported vocabulary.
const SUBSET = new Set([
  "$ref",
  "type",
  "properties",
  "required",
  "items",
  "minimum",
  "maximum",
  "minItems",
  "minLength",
  "format",
  "enum",
  "description",
  "additionalProperties",
]);
function assertSubset(schema: unknown): void {
  if (typeof schema === "boolean") return;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema))
    throw new Error("Expected a native example Schema Object.");
  const node = schema as Record<string, unknown>;
  for (const key of Object.keys(node)) {
    if (!SUBSET.has(key)) throw new Error(`Example payload validator does not support ${key}.`);
  }
  if (node.properties) for (const child of Object.values(node.properties)) assertSubset(child);
  if (node.items !== undefined) assertSubset(node.items);
  if (node.additionalProperties !== undefined) assertSubset(node.additionalProperties);
}
function nativeValidators(document: AsyncAPIDocument): Ajv {
  const ajv = addFormatsModule.default(
    new Ajv({
      strict: false,
      allErrors: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    }),
  );
  for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
    assertSubset(schema);
    ajv.addSchema(schema, `#/components/schemas/${name}`);
  }
  return ajv;
}
const NATIVE = [
  ["gateway", GATEWAY, nativeValidators(GATEWAY)],
  ["processor", PROCESSOR, nativeValidators(PROCESSOR)],
  ["fulfillment", FULFILLMENT, nativeValidators(FULFILLMENT)],
] as const;
const ORDER_REF = "#/components/schemas/Orders.Domain.Order";
const HTTP_REQUEST = compileOpenAPI31Schema(
  HTTP,
  "#/paths/~1orders/post/requestBody/content/application~1json/schema",
);
const HTTP_RESPONSE = compileOpenAPI31Schema(
  HTTP,
  "#/paths/~1orders~1{orderId}/get/responses/200/content/application~1json/schema",
);
const ORDER_READERS = [
  ["HTTP request", HTTP_REQUEST],
  ["HTTP response", HTTP_RESPONSE],
  ...NATIVE.map(([name, , ajv]) => [name, ajv.compile({ $ref: ORDER_REF })] as const),
] as const;

function assertAccepts(validate: ValidateFunction, value: unknown): void {
  const before = structuredClone(value);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  expect(value).toStrictEqual(before);
}

function nativeValueErrors(
  name: string,
  constraint: NativeString,
  value: unknown,
  contentType: string | undefined,
): string[] {
  if (value === undefined && !constraint.required) return [];
  if (typeof value !== "string" || value.length === 0) return [`${name}: required nonempty string`];
  const errors: string[] = [];
  if (name === "ContentType" && value !== contentType) errors.push("ContentType: mismatch");
  if (constraint.const !== undefined && value !== constraint.const)
    errors.push(`${name}: const mismatch`);
  const limit =
    constraint.maxLength ??
    (["MessageId", "SessionId", "ReplyToSessionId"].includes(name) ? 128 : undefined);
  if (limit !== undefined && value.length > limit) errors.push(`${name}: too long`);
  return errors;
}

/** Fixture-value checks only. The library/compiler owns profile conformance. */
function nativeErrors(message: MessageObject, values: Record<string, unknown>): string[] {
  const profile = message[EXTENSION_KEY] as MessageProfile;
  const properties = profile.nativeProperties ?? {};
  const errors: string[] = [];
  for (const name of Object.keys(properties) as (keyof NativeProperties)[]) {
    const constraint = properties[name];
    if (constraint)
      errors.push(...nativeValueErrors(name, constraint, values[name], message.contentType));
  }
  return errors;
}

describe("Interoperability: actual native JSON instances", () => {
  it("keeps one domain declaration without transport annotations", () => {
    const source = readFileSync(join(INTEROPERABILITY_ROOT, "domain/order.tsp"), "utf8");
    expect(source.match(/model Order \{/g)).toHaveLength(1);
    expect(source).not.toMatch(
      /import |@(?:message|header|body|channel|service|infoProfile|channelProfile|messageProfile|operationProfile)\b/,
    );
    expect(FLOW.command.payload.order).toStrictEqual(FLOW.http.request);
    expect(FLOW.event.payload.order).toStrictEqual(FLOW.http.request);
    expect(
      resolveRef(HTTP, "#/paths/~1orders/post/requestBody/content/application~1json/schema"),
    ).toEqual({ $ref: ORDER_REF });
    for (const [, document] of NATIVE) {
      const messages = messagesOf(document);
      for (const name of ["PlaceOrder", "OrderPlaced"]) {
        if (!Object.hasOwn(messages, name)) continue;
        const message = messages[name];
        const payload = resolveRef(document, (message.payload as { $ref: string }).$ref) as {
          properties: { order: unknown };
        };
        expect(payload.properties.order).toEqual({ $ref: ORDER_REF });
      }
    }
  });

  it.each(ORDER_READERS)(
    "accepts HTTP-, command-, and event-origin Order values with %s",
    (_name, validate) => {
      for (const value of [FLOW.http.request, FLOW.command.payload.order, FLOW.event.payload.order])
        assertAccepts(validate, value);
      const boundary = { ...FLOW.http.request, items: [{ sku: "widget-1", quantity: 1000 }] };
      assertAccepts(validate, boundary);
    },
  );

  it.each(INVALID)("rejects $name in every HTTP/message Order reader", ({ order, keyword }) => {
    for (const [name, validate] of ORDER_READERS) {
      const before = structuredClone(order);
      expect(validate(order), name).toBe(false);
      expect(
        validate.errors?.map((error) => error.keyword),
        name,
      ).toContain(keyword);
      expect(order).toStrictEqual(before);
    }
  });

  it.each(NATIVE)(
    "checks complete envelopes and application headers for %s",
    (_name, document, ajv) => {
      const fixtures = {
        PlaceOrder: FLOW.command,
        OrderCommandResult: FLOW.result,
        OrderPlaced: FLOW.event,
      };
      for (const [name, message] of Object.entries(messagesOf(document))) {
        const fixture = fixtures[name as keyof typeof fixtures];
        const body = ajv.compile(message.payload as object);
        const headers = ajv.compile(message.headers as object);
        assertAccepts(body, fixture.payload);
        assertAccepts(headers, fixture.headers);
        expect(nativeErrors(message, fixture.native)).toEqual([]);
        const profile = message[EXTENSION_KEY] as MessageProfile;
        expect(Object.keys(profile.nativeProperties ?? {})).toEqual(Object.keys(fixture.native));
        for (const name of Object.keys(fixture.native)) {
          expect(profile).toHaveProperty(`nativeProperties.${name}.required`, true);
        }
        expect(profile.ttlSeconds).toBe(3600);
        expect(fixture.amqpHeader.ttl).toBe(3600000);
        expect(headers({ ...fixture.headers, MessageId: fixture.native.MessageId })).toBe(false);
        expect(headers.errors?.map((error) => error.keyword)).toContain("additionalProperties");
        expect(headers({ ...fixture.headers, traceId: "invalid" })).toBe(false);
        expect(headers.errors?.map((error) => error.keyword)).toContain("format");
        for (const key of Object.keys(fixture.native)) {
          const schema = resolveRef(document, (message.headers as { $ref: string }).$ref) as {
            properties: object;
          };
          expect(schema.properties).not.toHaveProperty(key);
        }
        if (name !== "OrderCommandResult") {
          expect(body(FLOW.http.request)).toBe(false);
          for (const { order } of INVALID) expect(body({ ...fixture.payload, order })).toBe(false);
        }
      }
    },
  );

  it("keeps HTTP receipts and messaging envelopes distinct", () => {
    expect(HTTP_REQUEST(FLOW.command.payload)).toBe(false);
    expect(HTTP_REQUEST(FLOW.event.payload)).toBe(false);
    const receipt = compileOpenAPI31Schema(
      HTTP,
      "#/paths/~1orders/post/responses/202/content/application~1json/schema",
    );
    assertAccepts(receipt, FLOW.http.accepted);
    expect(receipt({ ...FLOW.http.accepted, state: "accepted" })).toBe(false);
    const result = NATIVE[1][2].compile(messagesOf(PROCESSOR).OrderCommandResult.payload as object);
    assertAccepts(result, {
      ...FLOW.result.payload,
      outcome: "rejected",
      reason: "Business validation failed.",
    });
    expect(result({ ...FLOW.result.payload, outcome: "unknown" })).toBe(false);
    const event = NATIVE[1][2].compile(messagesOf(PROCESSOR).OrderPlaced.payload as object);
    expect(event({ ...FLOW.event.payload, occurredAt: "yesterday" })).toBe(false);
    expect(event.errors?.map((error) => error.keyword)).toContain("format");
    expect(INVALID).toHaveLength(8);
  });

  it("documents native correlation, distinct identities, and reply sessions as fixture invariants", () => {
    expect(FLOW.command.native.MessageId).toBe(FLOW.http.idempotencyKey);
    expect(FLOW.command.native.CorrelationId).toBe(FLOW.command.payload.commandId);
    expect(FLOW.command.native.SessionId).toBe(FLOW.http.request.orderId);
    expect(FLOW.command.native.ReplyTo).toBe(channelsOf(GATEWAY).replies.address);
    expect(FLOW.command.native.ReplyToSessionId).toBe(FLOW.command.payload.commandId);
    expect(FLOW.result.native.CorrelationId).toBe(FLOW.command.native.MessageId);
    expect(FLOW.result.native.SessionId).toBe(FLOW.command.native.ReplyToSessionId);
    expect(FLOW.result.native.SessionId).not.toBe(FLOW.command.native.SessionId);
    expect(FLOW.event.native.MessageId).toBe(FLOW.event.payload.eventId);
    expect(FLOW.event.native.CorrelationId).toBe(FLOW.command.native.MessageId);
    expect(FLOW.event.native.SessionId).toBe(FLOW.http.request.orderId);
    expect(
      new Set([
        FLOW.command.native.MessageId,
        FLOW.result.native.MessageId,
        FLOW.event.native.MessageId,
      ]).size,
    ).toBe(3);
    expect(FLOW.result.headers.causationId).toBe(FLOW.command.native.MessageId);
    expect(FLOW.event.headers.causationId).toBe(FLOW.command.native.MessageId);
    expect(NATIVE_PROPERTY_MAPPINGS.SessionId).toBe("properties/group-id");
    expect(NATIVE_PROPERTY_MAPPINGS.ReplyToSessionId).toBe("properties/reply-to-group-id");
  });

  it("rejects invalid native fixture values without inventing application-header mirrors", () => {
    const message = messagesOf(GATEWAY).PlaceOrder;
    const missing = { ...FLOW.command.native };
    delete missing.SessionId;
    expect(nativeErrors(message, missing)).toContain("SessionId: required nonempty string");
    expect(nativeErrors(message, { ...FLOW.command.native, MessageId: "x".repeat(129) })).toContain(
      "MessageId: too long",
    );
    expect(nativeErrors(message, { ...FLOW.command.native, ContentType: "text/plain" })).toContain(
      "ContentType: mismatch",
    );
    expect(nativeErrors(message, { ...FLOW.command.native, Subject: "wrong" })).toContain(
      "Subject: const mismatch",
    );
  });
});
