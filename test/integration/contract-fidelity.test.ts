import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { AsyncAPIDocument } from "#emitter/types/index.js";
import { emitDocument, emitDocumentWithDiagnostics } from "../utils/test-host.js";
import {
  createMessageValidator,
  createPayloadValidator,
  emittedSchema,
} from "../utils/payload-validation.js";
import { nativeFixtures } from "../fixtures/contract-fidelity/native.js";

const channel = '@channel("events") interface Events { @send op send(event: Event): void; }';
const source = (field: string, declarations = "") =>
  `${declarations} @message model Event { ${field} } ${channel}`;

describe("Contract fidelity: emitted payload acceptance", () => {
  it.each(nativeFixtures)("$id preserves accepted and rejected wire witnesses", async (row) => {
    const doc = await emitDocument(source(row.field, row.declarations));
    await expect(doc).toBeValidAsyncAPI();
    const validator = createMessageValidator(doc, "Event", {
      annotationFormats: row.annotationFormats,
    });
    for (const [values, expected] of [
      [row.valid, true],
      [row.invalid, false],
    ] as const) {
      for (const value of values) {
        const message = { payload: { value } };
        const before = structuredClone(message);
        expect(validator.validate(message).accepted, JSON.stringify(message)).toBe(expected);
        expect(message).toEqual(before);
      }
    }
  });

  it("F01 explicit format-annotation profile is weaker but still enforces type", async () => {
    const doc = await emitDocument(source('@format("uuid") value: string;'));
    const asserting = createMessageValidator(doc, "Event");
    const annotating = createMessageValidator(doc, "Event", { formats: "annotation" });
    expect(asserting.validate({ payload: { value: "not-a-uuid" } }).accepted).toBe(false);
    expect(annotating.validate({ payload: { value: "not-a-uuid" } }).accepted).toBe(true);
    expect(annotating.validate({ payload: { value: 1 } }).accepted).toBe(false);
  });

  it("F02 bounded deterministic integer witnesses agree with the authored interval", async () => {
    const doc = await emitDocument(source("@minValue(0) @maxValue(10) value: int32;"));
    const validator = createMessageValidator(doc, "Event");
    fc.assert(
      fc.property(fc.integer({ min: -20, max: 30 }), (value) => {
        expect(validator.validate({ payload: { value } }).accepted).toBe(value >= 0 && value <= 10);
      }),
      { seed: 3107, numRuns: 64 },
    );
  });

  it.each([
    ["required", "value: string;", [false, false, true, false]],
    ["optional", "value?: string;", [true, false, true, false]],
    ["required nullable", "value: string | null;", [false, true, true, false]],
    ["optional nullable", "value?: string | null;", [true, true, true, false]],
    ["required default", 'value: string = "default";', [false, false, true, false]],
    ["optional default", 'value?: string = "default";', [true, false, true, false]],
  ] as const)("F04 %s presence and nonmutating defaults", async (_, field, outcomes) => {
    const doc = await emitDocument(source(field));
    const validator = createMessageValidator(doc, "Event");
    for (const [index, payload] of [
      {},
      { value: null },
      { value: "text" },
      { value: 1 },
    ].entries()) {
      const before = structuredClone(payload);
      expect(validator.validate({ payload }).accepted).toBe(outcomes[index]);
      expect(payload).toEqual(before);
    }
  });

  it("F05 encoded examples and defaults are wire values, not injected values", async () => {
    const doc = await emitDocument(
      source(`
      @example(utcDateTime.fromISO("2020-01-01T00:00:00Z"))
      @encode("unixTimestamp", int32)
      value?: utcDateTime = utcDateTime.fromISO("2020-01-01T00:00:00Z");
    `),
    );
    const body = emittedSchema(doc, doc.components?.messages?.Event.payload);
    expect(body).toMatchObject({
      properties: { value: { type: "integer", default: 1577836800, examples: [1577836800] } },
    });
    expect(
      createMessageValidator(doc, "Event").validate({ payload: { value: 1577836800 } }).accepted,
    ).toBe(true);
  });

  it.each(["enum Empty {}", "union Empty {}"])(
    "F06 empty branch set accepts nothing: %s",
    async (declarations) => {
      const doc = await emitDocument(source("value: Empty;", declarations));
      const validator = createMessageValidator(doc, "Event");
      for (const value of [null, 0, "", {}, []]) {
        expect(validator.validate({ payload: { value } }).accepted).toBe(false);
      }
    },
  );

  it.each([
    ["", { kind: "cat", value: { meow: true } }, { kind: "dog", value: { meow: true } }],
    [
      '(#{ discriminatorPropertyName: "tag", envelopePropertyName: "body" })',
      { tag: "cat", body: { meow: true } },
      { kind: "cat", value: { meow: true } },
    ],
    ['(#{ envelope: "none" })', { kind: "cat", meow: true }, { meow: true }],
  ])("F06 discriminated envelope %s", async (options, valid, invalid) => {
    const doc = await emitDocument(
      source(
        "value: Pet;",
        `
      @discriminated${options} union Pet { cat: Cat, dog: Dog }
      model Cat { kind: "cat"; meow: boolean; }
      model Dog { kind: "dog"; bark: boolean; }
    `,
      ),
    );
    const validator = createMessageValidator(doc, "Event");
    // Enveloped variants carry the declared model's discriminator too.
    const payload = structuredClone(valid);
    if ("value" in payload && typeof payload.value === "object")
      Object.assign(payload.value, { kind: "cat" });
    if ("body" in payload && typeof payload.body === "object")
      Object.assign(payload.body, { kind: "cat" });
    expect(validator.validate({ payload: { value: payload } }).accepted).toBe(true);
    expect(validator.validate({ payload: { value: invalid } }).accepted).toBe(false);
  });

  it("F07 inherited required fields and nested recursive refs survive promotion", async () => {
    const doc = await emitDocument(`
      model Base { @minLength(2) id: string; }
      model Mid extends Base { count: int32; }
      model Leaf extends Mid { child?: Leaf; label: string; }
      @message model Event { a: Leaf; b: Leaf; } ${channel}
    `);
    const validate = createMessageValidator(doc, "Event");
    const leaf = { id: "ab", count: 1, label: "leaf" };
    expect(validate.validate({ payload: { a: { ...leaf, child: leaf }, b: leaf } }).accepted).toBe(
      true,
    );
    for (const bad of [
      { count: 1, label: "leaf" },
      { ...leaf, id: "a" },
    ]) {
      expect(validate.validate({ payload: { a: bad, b: leaf } }).accepted).toBe(false);
    }
  });

  it.each(["own", "inherited", "explicit"])(
    "F08 %s headers have independent acceptance",
    async (mode) => {
      const field = '@encodedName("application/json", "x-id") @minLength(2) id: string;';
      const declarations: Record<string, string> = {
        explicit: `model Headers { ${field} } @headers(Headers) @message model Event { body: int32; }`,
        inherited: `@message model Base { @header ${field} } @message model Event extends Base { body: int32; }`,
        own: `@message model Event { @header ${field} body: int32; }`,
      };
      const declaration = declarations[mode];
      const doc = await emitDocument(`${declaration} ${channel}`);
      await expect(doc).toBeValidAsyncAPI();
      const validator = createMessageValidator(doc, "Event");
      expect(validator.validate({ payload: { body: 1 }, headers: { "x-id": "ab" } }).accepted).toBe(
        true,
      );
      const missingHeader = validator.validate({ payload: { body: 1 }, headers: {} });
      expect(missingHeader.accepted).toBe(false);
      expect(missingHeader.errors.every((error) => error.startsWith("headers"))).toBe(true);
      const missingPayload = validator.validate({ payload: {}, headers: { "x-id": "ab" } });
      expect(missingPayload.accepted).toBe(false);
      expect(missingPayload.errors.every((error) => error.startsWith("payload"))).toBe(true);
    },
  );

  it("F10 visibility omits invisible fields but does not project partial lifecycle", async () => {
    const { doc, diagnostics } = await emitDocumentWithDiagnostics(
      source(`
      @invisible(Lifecycle) hidden: string;
      @visibility(Lifecycle.Read) value: string;
    `),
    );
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["tsp-asyncapi/visibility-not-applied", "warning"],
    ]);
    if (!doc) throw new Error("Expected a warned document");
    const validator = createMessageValidator(doc, "Event");
    expect(validator.validate({ payload: { value: "read" } }).accepted).toBe(true);
    expect(validator.validate({ payload: {} }).accepted).toBe(false);
  });

  it("F08 lifting does not erase header fields from ordinary shared-model use", async () => {
    const doc = await emitDocument(`
      @message model Shared { @header trace: string; value: int32; }
      @message model Event { nested: Shared; } ${channel}
    `);
    const standalone = createMessageValidator(doc, "Shared");
    expect(standalone.validate({ payload: { value: 1 }, headers: { trace: "t" } }).accepted).toBe(
      true,
    );
    const nested = createMessageValidator(doc, "Event");
    expect(nested.validate({ payload: { nested: { value: 1, trace: "t" } } }).accepted).toBe(true);
    expect(nested.validate({ payload: { nested: { value: 1 } } }).accepted).toBe(false);
  });
});

describe("Payload validator reference and dialect boundaries", () => {
  const document = (payload: unknown): AsyncAPIDocument =>
    ({
      asyncapi: "3.1.0",
      info: { title: "authored", version: "1" },
      components: { messages: { Event: { payload } } },
    }) as AsyncAPIDocument;

  it("follows escaped refs, retains recursion, and isolates documents", () => {
    const doc = document({ $ref: "#/components/schemas/a~1b~0c" });
    doc.components = {
      ...doc.components,
      schemas: {
        "a/b~c": {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            child: { $ref: "#/components/schemas/a~1b~0c" },
          },
        },
      },
    };
    const first = createMessageValidator(doc, "Event");
    expect(first.validate({ payload: { id: "a", child: { id: "b" } } }).accepted).toBe(true);
    expect(first.validate({ payload: { id: "a", child: {} } }).accepted).toBe(false);
    const other = structuredClone(doc);
    if (!other.components?.schemas) throw new Error("Missing schemas");
    other.components.schemas["a/b~c"] = { type: "integer" };
    expect(createMessageValidator(other, "Event").validate({ payload: 1 }).accepted).toBe(true);
    expect(first.validate({ payload: 1 }).accepted).toBe(false);
  });

  it("rejects missing/external/circular outer refs and unknown validation vocabularies", () => {
    for (const payload of [
      { $ref: "#/components/schemas/missing" },
      { $ref: "https://example.invalid/schema" },
      { $ref: "#/components/messages/Event/payload" },
      { type: "string", format: "custom-unimplemented" },
      { type: "object", unevaluatedProperties: false },
    ])
      expect(() => createMessageValidator(document(payload), "Event")).toThrow();
  });

  it.each(["yaml", "json"])("F09 native and raw draft07 %s serialization", async (fileType) => {
    for (const format of ["native", `application/schema+${fileType};version=draft-07`]) {
      const code =
        format === "native"
          ? source("@minLength(2) value: string;")
          : `@message @rawPayload("${format}", #{ type: "object", required: #["value"],
          properties: #{ value: #{ type: "string", minLength: 2 } } }) model Event {} ${channel}`;
      const doc = await emitDocument(code, { "file-type": fileType });
      await expect(doc).toBeValidAsyncAPI();
      const validator = createMessageValidator(doc, "Event");
      expect(validator.validate({ payload: { value: "ab" } }).accepted).toBe(true);
      expect(validator.validate({ payload: { value: "a" } }).accepted).toBe(false);
    }
  });

  it("raw draft07 owns internal recursive definitions", () => {
    const doc = document({
      schemaFormat: "application/schema+json;version=draft-07",
      schema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          child: { $ref: "#" },
        },
      },
    });
    const validator = createMessageValidator(doc, "Event");
    expect(validator.validate({ payload: { id: "a", child: { id: "b" } } }).accepted).toBe(true);
    expect(validator.validate({ payload: { id: "a", child: {} } }).accepted).toBe(false);
  });

  it("F09 malformed raw JSON schema is not mistaken for a rejected payload", () => {
    const doc = document({
      schemaFormat: "application/schema+json;version=draft-07",
      schema: { type: "invalid" },
    });
    expect(() => createMessageValidator(doc, "Event")).toThrow();
    expect(() => createMessageValidator(doc, "Missing")).toThrow("Missing emitted message");
  });

  it.each(["application/vnd.oai.openapi;version=3.0.0", "application/raml+yaml;version=1.0"])(
    "F09 %s is identifier pass-through, not a validation lane",
    (schemaFormat) => {
      expect(() => createMessageValidator(document({ schemaFormat, schema: {} }), "Event")).toThrow(
        "pass-through schemaFormat",
      );
    },
  );

  it("F09 actual binary payload validation differs from parsing and requires a root", () => {
    const avro = document({
      schemaFormat: "application/vnd.apache.avro;version=1.9.0",
      schema: { type: "record", name: "Event", fields: [{ name: "id", type: "string" }] },
    });
    const av = createMessageValidator(avro, "Event");
    expect(av.validate({ payload: { id: "a" } }).accepted).toBe(true);
    expect(av.validate({ payload: { id: 1 } }).accepted).toBe(false);
    for (const syntax of ["proto2", "proto3"]) {
      const proto = document({
        schemaFormat: `application/vnd.google.protobuf;version=${syntax.slice(-1)}`,
        schema: `syntax = "${syntax}"; message Wire { ${syntax === "proto2" ? "required " : ""} string id = 1; }`,
      });
      expect(() => createMessageValidator(proto, "Event")).toThrow("root");
      expect(() => createMessageValidator(proto, "Event", { protobufRoot: "Missing" })).toThrow();
      const validator = createMessageValidator(proto, "Event", { protobufRoot: "Wire" });
      expect(validator.validate({ payload: { id: "a" } }).accepted).toBe(true);
      expect(validator.validate({ payload: { id: 1 } }).accepted).toBe(false);
    }
    expect(() =>
      createPayloadValidator(avro, {
        schemaFormat: "application/vnd.apache.avro;version=1.9.0",
        schema: { type: "record" },
      }),
    ).toThrow();
  });
});
