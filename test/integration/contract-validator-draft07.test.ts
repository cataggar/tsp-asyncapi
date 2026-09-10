import { describe, expect, it } from "vitest";
import type { AsyncAPIDocument } from "#emitter/types/index.js";
import { createMessageValidator, createPayloadValidator } from "../utils/payload-validation.js";
import { emitDocument } from "../utils/test-host.js";

const document: AsyncAPIDocument = {
  asyncapi: "3.1.0",
  info: { title: "Dialect oracle", version: "1" },
};
const raw = (schema: unknown) => ({
  schemaFormat: "application/schema+json;version=draft-07",
  schema,
});

describe("Draft-07 validation oracle", () => {
  it("rejects OpenAPI nullable at schema positions instead of silently extending draft-07", () => {
    expect(() => createPayloadValidator(document, raw({ type: "string", nullable: true }))).toThrow(
      "nullable",
    );
    const validator = createPayloadValidator(document, raw({ type: ["string", "null"] }));
    expect(validator.validate(null).accepted).toBe(true);
    expect(validator.validate("text").accepted).toBe(true);
    expect(validator.validate(1).accepted).toBe(false);
  });

  it.each([
    { type: "string" },
    { type: "string", minLength: 3, pattern: "^text$" },
    { type: "object", required: ["id"], additionalProperties: false },
    { allOf: [false], const: "text" },
  ])("ignores draft-07 reference siblings %j, retaining real definitions", (siblings) => {
    const schema = { definitions: { Any: {} }, $ref: "#/definitions/Any", ...siblings };
    const before = structuredClone(schema);
    const validator = createPayloadValidator(document, raw(schema));
    expect(validator.validate(1).accepted).toBe(true);
    expect(validator.validate(null).accepted).toBe(true);
    expect(validator.validate("x").accepted).toBe(true);
    expect(schema).toEqual(before);
  });

  it("retains a real native component identifier without registering a second copy", async () => {
    const doc = await emitDocument(`
      @jsonSchemaExtension("$id", "https://example.test/schemas/Event")
      @message model Event { id: string; }
      @channel("events") interface Events { @send op send(event: Event): void; }
    `);
    const before = structuredClone(doc);
    const validator = createMessageValidator(doc, "Event");
    expect(validator.validate({ payload: { id: "a" } }).accepted).toBe(true);
    expect(validator.validate({ payload: { id: 1 } }).accepted).toBe(false);
    expect(doc).toEqual(before);
  });

  it("honors validation in an allOf wrapper rather than reference siblings", async () => {
    const doc = await emitDocument(`
      scalar Name extends string;
      @message model Event { @minLength(3) name: Name; }
      @channel("events") interface Events { @send op send(event: Event): void; }
    `);
    const validator = createMessageValidator(doc, "Event");
    expect(validator.validate({ payload: { name: "abc" } }).accepted).toBe(true);
    expect(validator.validate({ payload: { name: "ab" } }).accepted).toBe(false);
    expect(validator.validate({ payload: { name: 1 } }).accepted).toBe(false);
  });

  it("does not index opaque annotation identifiers or mutate the original schema", () => {
    const schema = {
      definitions: { Id: { $id: "#id", type: "string" } },
      type: "object",
      properties: { value: { $ref: "#id" } },
      required: ["value"],
      "x-note": { $id: "#id", type: "integer" },
      externalDocs: { url: "https://example.test/docs", $id: "#id" },
      examples: [{ $id: "#id" }],
    };
    const before = structuredClone(schema);
    const validator = createPayloadValidator(document, raw(schema));
    expect(validator.validate({ value: "text" }).accepted).toBe(true);
    expect(validator.validate({ value: 1 }).accepted).toBe(false);
    expect(schema).toEqual(before);
  });

  it("does not resolve a live reference to an identifier found only in an annotation", () => {
    expect(() =>
      createPayloadValidator(
        document,
        raw({
          type: "object",
          properties: { value: { $ref: "#ghost" } },
          "x-note": { $id: "#ghost", type: "string" },
        }),
      ),
    ).toThrow();
  });

  it("retains literal const/enum data and schema keywords used as property names", () => {
    const literal = { $id: "#literal", nullable: true, "x-note": { $ref: "#data" } };
    const schema = {
      type: "object",
      definitions: { Id: { $id: "#literal", type: "string" } },
      properties: {
        nullable: { const: literal },
        "x-note": { enum: [literal] },
        definitions: { $ref: "#literal" },
      },
      required: ["nullable", "x-note", "definitions"],
    };
    const validator = createPayloadValidator(document, raw(schema));
    const value = { nullable: literal, "x-note": literal, definitions: "text" };
    expect(validator.validate(value).accepted).toBe(true);
    expect(
      validator.validate({ ...value, nullable: { ...literal, nullable: false } }).accepted,
    ).toBe(false);
    expect(validator.validate({ ...value, definitions: 1 }).accepted).toBe(false);
  });

  it("traverses annotations only at schema positions in dependencies, tuples and contains", () => {
    const schema = {
      definitions: { Id: { $id: "#id", type: "string" } },
      type: "object",
      dependencies: {
        trigger: { properties: { value: { $ref: "#id", "x-note": { $id: "#id" } } } },
        value: ["trigger"],
      },
      properties: {
        list: {
          type: "array",
          items: [{ type: "string", "x-note": { $id: "#id" } }],
          additionalItems: { type: "integer", "x-note": { $id: "#id" } },
          contains: { type: "string", "x-note": { $id: "#id" } },
        },
      },
    };
    const validator = createPayloadValidator(document, raw(schema));
    expect(validator.validate({ trigger: true, value: "text", list: ["a", 1] }).accepted).toBe(
      true,
    );
    expect(validator.validate({ trigger: true, value: 1 }).accepted).toBe(false);
    expect(validator.validate({ list: ["a", "b"] }).accepted).toBe(false);
  });

  it("does not normalize explicit null headers into an absent optional header object", async () => {
    const doc = await emitDocument(`
      model Headers { trace?: string; }
      @headers(Headers) @message model Event { id: string; }
      @channel("events") interface Events { @send op send(event: Event): void; }
    `);
    const validator = createMessageValidator(doc, "Event");
    expect(validator.validate({ payload: { id: "a" } }).accepted).toBe(true);
    expect(validator.validate({ payload: { id: "a" }, headers: {} }).accepted).toBe(true);
    const result = validator.validate({ payload: { id: "a" }, headers: null });
    expect(result.accepted).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("headers")]);
  });
});
