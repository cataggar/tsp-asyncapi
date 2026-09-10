import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidateFunction } from "ajv";
import { EXTENSION_KEY, NATIVE_PROPERTY_MAPPINGS } from "tsp-azure-service-bus";
import type { MessageProfile, NativeProperties, NativeString } from "tsp-azure-service-bus/types";
import type { AsyncAPIDocument, MessageObject } from "#emitter/types/index.js";
import { messagesOf, channelsOf } from "../utils/document.js";
import { resolveRef } from "../utils/json-pointer.js";
import { compileOpenAPI31Schema } from "../utils/openapi-validation.js";
import {
  createMessageValidator,
  createPayloadValidator,
  type PayloadValidator,
} from "../utils/payload-validation.js";
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

const NATIVE = [
  ["gateway", GATEWAY],
  ["processor", PROCESSOR],
  ["fulfillment", FULFILLMENT],
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
  ...NATIVE.map(
    ([name, document]) => [name, createPayloadValidator(document, { $ref: ORDER_REF })] as const,
  ),
] as const;

function assertAccepts(validator: ValidateFunction | PayloadValidator, value: unknown): void {
  const before = structuredClone(value);
  if (typeof validator === "function") {
    expect(validator(value), JSON.stringify(validator.errors)).toBe(true);
  } else {
    expect(validator.lane).toBe("draft-07");
    const result = validator.validate(value);
    expect(result.accepted, result.errors.join("\n")).toBe(true);
    expect(result.errors).toEqual([]);
  }
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
      if (typeof validate === "function") {
        expect(validate(order), name).toBe(false);
        expect(
          validate.errors?.map((error) => error.keyword),
          name,
        ).toContain(keyword);
      } else {
        const result = validate.validate(order);
        expect(result.accepted, name).toBe(false);
        expect(
          result.errors.some((error) => error.includes(`: ${keyword} `)),
          name,
        ).toBe(true);
      }
      expect(order).toStrictEqual(before);
    }
  });

  it.each(NATIVE)("checks complete envelopes and application headers for %s", (_name, document) => {
    const fixtures = {
      PlaceOrder: FLOW.command,
      OrderCommandResult: FLOW.result,
      OrderPlaced: FLOW.event,
    };
    for (const [name, message] of Object.entries(messagesOf(document))) {
      const fixture = fixtures[name as keyof typeof fixtures];
      const validator = createMessageValidator(document, name);
      const body = validator.payload;
      const headers = validator.headers;
      if (!headers) throw new Error(`Expected declared application headers for ${name}.`);
      assertAccepts(body, fixture.payload);
      assertAccepts(headers, fixture.headers);
      const before = structuredClone(fixture);
      const complete = validator.validate(fixture);
      expect(complete.accepted, complete.errors.join("\n")).toBe(true);
      expect(complete.errors).toEqual([]);
      expect(fixture).toStrictEqual(before);
      expect(nativeErrors(message, fixture.native)).toEqual([]);
      const profile = message[EXTENSION_KEY] as MessageProfile;
      expect(Object.keys(profile.nativeProperties ?? {})).toEqual(Object.keys(fixture.native));
      for (const name of Object.keys(fixture.native)) {
        expect(profile).toHaveProperty(`nativeProperties.${name}.required`, true);
      }
      expect(profile.ttlSeconds).toBe(3600);
      expect(fixture.amqpHeader.ttl).toBe(3600000);
      const protocolHeader = validator.validate({
        payload: fixture.payload,
        headers: { ...fixture.headers, MessageId: fixture.native.MessageId },
      });
      expect(protocolHeader.accepted).toBe(false);
      expect(
        protocolHeader.errors.some(
          (error) => error.startsWith("headers") && error.includes(": additionalProperties "),
        ),
      ).toBe(true);
      const invalidTrace = headers.validate({ ...fixture.headers, traceId: "invalid" });
      expect(invalidTrace.accepted).toBe(false);
      expect(invalidTrace.errors.some((error) => error.includes(": format "))).toBe(true);
      for (const key of Object.keys(fixture.native)) {
        const schema = resolveRef(document, (message.headers as { $ref: string }).$ref) as {
          properties: object;
        };
        expect(schema.properties).not.toHaveProperty(key);
      }
      if (name !== "OrderCommandResult") {
        expect(body.validate(FLOW.http.request).accepted).toBe(false);
        for (const { order, keyword } of INVALID) {
          const result = body.validate({ ...fixture.payload, order });
          expect(result.accepted).toBe(false);
          expect(result.errors.some((error) => error.includes(`: ${keyword} `))).toBe(true);
        }
      }
    }
  });

  it("keeps HTTP receipts and messaging envelopes distinct", () => {
    expect(HTTP_REQUEST(FLOW.command.payload)).toBe(false);
    expect(HTTP_REQUEST(FLOW.event.payload)).toBe(false);
    const receipt = compileOpenAPI31Schema(
      HTTP,
      "#/paths/~1orders/post/responses/202/content/application~1json/schema",
    );
    assertAccepts(receipt, FLOW.http.accepted);
    expect(receipt({ ...FLOW.http.accepted, state: "accepted" })).toBe(false);
    const result = createMessageValidator(PROCESSOR, "OrderCommandResult").payload;
    assertAccepts(result, {
      ...FLOW.result.payload,
      outcome: "rejected",
      reason: "Business validation failed.",
    });
    const invalidResult = result.validate({ ...FLOW.result.payload, outcome: "unknown" });
    expect(invalidResult.accepted).toBe(false);
    expect(invalidResult.errors.some((error) => error.includes(": enum "))).toBe(true);
    const event = createMessageValidator(PROCESSOR, "OrderPlaced").payload;
    const invalidEvent = event.validate({ ...FLOW.event.payload, occurredAt: "yesterday" });
    expect(invalidEvent.accepted).toBe(false);
    expect(invalidEvent.errors.some((error) => error.includes(": format "))).toBe(true);
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
