import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { emitOpenAPI31 } from "../utils/openapi-emitter.js";
import { compileOpenAPI31Schema, validateOpenAPI31Document } from "../utils/openapi-validation.js";

const FIXTURES = new URL("../fixtures/openapi/", import.meta.url);
const SCHEMA = "#/components/schemas/Value";

function documentWith(schema: unknown) {
  return {
    openapi: "3.1.0",
    info: { title: "Validation control", version: "1.0.0" },
    paths: {},
    components: { schemas: { Value: schema } },
  };
}

describe("Integration: pinned HTTP/OpenAPI preparation", () => {
  let emitted: Awaited<ReturnType<typeof emitOpenAPI31>>;

  beforeAll(async () => {
    emitted = await emitOpenAPI31(readFileSync(new URL("http/main.tsp", FIXTURES), "utf8"));
  });

  it("compiles the real fixture as OpenAPI 3.1.0 in both formats", () => {
    expect(emitted.document.openapi).toBe("3.1.0");
    expect(parse(emitted.yaml)).toStrictEqual(JSON.parse(emitted.json));
    expect(validateOpenAPI31Document(emitted.document)).toBeNull();
    expect(emitted.document.paths["/widgets"].post?.operationId).toBe("createWidget");
    expect(emitted.document.security).toEqual([{ BearerAuth: [] }]);
  });

  it("validates actual request instances separately from document structure", () => {
    const validate = compileOpenAPI31Schema(
      emitted.document,
      "#/paths/~1widgets/post/requestBody/content/application~1json/schema",
    );
    const valid = {
      id: "25b2468c-45b7-48b7-8552-bba6e5e42a4e",
      name: "Widget",
      quantity: 1,
    };
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    const cases = [
      [{ ...valid, id: "not-a-uuid" }, "format"],
      [{ ...valid, name: "" }, "minLength"],
      [{ ...valid, quantity: 0 }, "minimum"],
      [{ ...valid, quantity: 1.5 }, "type"],
      [{ ...valid, quantity: 2 ** 31 }, "format"],
    ] as const;
    for (const [value, keyword] of cases) {
      expect(validate(value)).toBe(false);
      expect(validate.errors?.map((error) => error.keyword)).toContain(keyword);
    }
    expect(validateOpenAPI31Document(emitted.document)).toBeNull();
  });

  it("does not auto-import another service supplied as an unused source file", async () => {
    const result = await emitOpenAPI31({
      "main.tsp": readFileSync(new URL("http/main.tsp", FIXTURES), "utf8"),
      "unused.tsp": "@service namespace Unrelated;",
    });
    expect(result.document).toStrictEqual(emitted.document);
  });
});

describe("OpenAPI 3.1 structure and schema controls", () => {
  it.each([
    [null, /document object/],
    [{ openapi: "3.1.0", paths: {} }, /required/],
    [{ ...documentWith({}), openapi: "3.0.0" }, /openapi.*pattern/],
    [documentWith({ type: "not-a-type" }), /\/type:.*enum/],
    [documentWith({ type: "number", minimum: "one" }), /\/minimum: type/],
    [documentWith({ type: "array", items: "not-a-schema" }), /\/items: type/],
    [documentWith({ type: "string", pattern: "[" }), /pattern|regular expression/i],
    [documentWith({ type: "string", format: "unregistered-format" }), /Unsupported schema format/],
    [documentWith({ $schema: "https://example.invalid/dialect" }), /Unsupported schema dialect/],
    [
      { ...documentWith({}), jsonSchemaDialect: "https://example.invalid/dialect" },
      /Unsupported document schema dialect/,
    ],
  ])("rejects an invalid document for its actual reason", (document, reason) => {
    expect(validateOpenAPI31Document(document)).toMatch(reason);
  });

  it("accepts valid schemas through the official dynamic-schema-slot adapter", () => {
    expect(
      validateOpenAPI31Document(
        documentWith({
          type: "object",
          properties: { value: { type: ["string", "null"] } },
          required: ["value"],
          unevaluatedProperties: false,
        }),
      ),
    ).toBeNull();
    expect(validateOpenAPI31Document(documentWith(false))).toBeNull();
    expect(compileOpenAPI31Schema(documentWith(false), SCHEMA)("anything")).toBe(false);
  });

  it.each(["$id", "$anchor", "$dynamicAnchor", "$dynamicRef"])(
    "refuses unsupported schema resource keyword %s instead of resolving it incorrectly",
    (keyword) => {
      expect(validateOpenAPI31Document(documentWith({ [keyword]: "local" }))).toMatch(
        /Unsupported schema resource keyword/,
      );
    },
  );

  it("checks OpenAPI-specific Schema Object vocabulary", () => {
    expect(
      validateOpenAPI31Document(
        documentWith({
          type: "object",
          discriminator: { propertyName: 123 },
        }),
      ),
    ).toMatch(/discriminator\/propertyName: type/);
  });

  it.each([
    ["application/json", true],
    ["application/*", true],
    ["*/*", true],
    ['application/json; charset="utf-8"', true],
    ["not a media range", false],
    ["*/json", false],
    ["application/json; broken", false],
  ])("checks the official schema media-range format: %s", (mediaType, valid) => {
    const document = {
      ...documentWith({ type: "string" }),
      paths: {
        "/value": {
          get: {
            responses: {
              "200": {
                description: "Value",
                content: { [mediaType]: { schema: { $ref: SCHEMA } } },
              },
            },
          },
        },
      },
    };
    const failure = validateOpenAPI31Document(document);
    if (valid) expect(failure).toBeNull();
    else expect(failure).toMatch(/media-range/);
  });
});

describe("OpenAPI document-local reference controls", () => {
  it.each([
    ["#/components/schemas/Missing", /Unresolved reference/],
    ["https://example.invalid/schema.json", /Unsupported non-local reference/],
    ["other.json#/Value", /Unsupported non-local reference/],
    ["#named-anchor", /Unsupported non-local reference/],
    ["#/components/schemas/Value~2", /Invalid JSON Pointer escape/],
    ["#/components/schemas/constructor", /Unresolved reference/],
    ["#/info", /does not target a schema/],
  ])("rejects schema reference %s for its actual reason", (ref, reason) => {
    expect(validateOpenAPI31Document(documentWith({ $ref: ref }))).toMatch(reason);
  });

  it("checks Reference Objects outside schemas", () => {
    expect(
      validateOpenAPI31Document({
        ...documentWith({}),
        paths: {
          "/value": { get: { responses: { "200": { $ref: "#/components/responses/Missing" } } } },
        },
      }),
    ).toMatch(/Unresolved reference.*responses\/Missing/);
    expect(
      validateOpenAPI31Document({
        ...documentWith({}),
        paths: { "/value": { $ref: "#/components/pathItems/Missing" } },
      }),
    ).toMatch(/Unresolved reference.*pathItems\/Missing/);
  });

  it("checks named security requirements", () => {
    expect(
      validateOpenAPI31Document({
        ...documentWith({}),
        security: [{ Missing: [] }],
      }),
    ).toMatch(/Unresolved security scheme: Missing/);
  });

  it("resolves recursion without following references forever", () => {
    const document = documentWith({
      type: "object",
      properties: { next: { $ref: SCHEMA } },
    });
    expect(validateOpenAPI31Document(document)).toBeNull();
    expect(compileOpenAPI31Schema(document, SCHEMA)({ next: { next: {} } })).toBe(true);
  });

  it("resolves URI and JSON Pointer escapes and accepts property names that look like keywords", () => {
    const document = documentWith({
      type: "object",
      properties: { "a/b": { type: "string" }, $ref: { type: "string" } },
    });
    const validate = compileOpenAPI31Schema(document, `${SCHEMA}/properties/%61~1b`);
    expect(validate("value")).toBe(true);
    expect(validate(1)).toBe(false);
    expect(validateOpenAPI31Document(document)).toBeNull();
  });

  it("does not interpret examples, defaults, or extensions as reference graphs", () => {
    expect(
      validateOpenAPI31Document(
        documentWith({
          type: "object",
          examples: [{ $ref: "not-a-document-reference" }],
          default: { $ref: "also-data" },
          "x-note": { $ref: "extension-data" },
        }),
      ),
    ).toBeNull();
  });

  it("requires an actual Schema Object pointer for instance validation", () => {
    expect(() => compileOpenAPI31Schema(documentWith({}), "#/info")).toThrow(
      /Schema Object pointer/,
    );
  });
});

describe("OpenAPI instance validator isolation", () => {
  it.each(["example", "x-note"])(
    "does not index a schema identifier inside %s annotation data",
    (annotation) => {
      const document = documentWith({
        type: "string",
        [annotation]: { $id: SCHEMA, type: "number" },
      });
      const original = structuredClone(document);
      expect(validateOpenAPI31Document(document)).toBeNull();
      const validate = compileOpenAPI31Schema(document, SCHEMA);
      expect(validate("expected")).toBe(true);
      expect(validate(42)).toBe(false);
      expect(document).toStrictEqual(original);
    },
  );

  it.each(["example", "x-note"])(
    "does not validate anchors inside nested %s annotation data",
    (annotation) => {
      const data = { nested: { $anchor: "arbitrary data, not an anchor" } };
      const document = documentWith({
        type: "object",
        properties: { value: { type: "string", [annotation]: data } },
      });
      const original = structuredClone(document);
      expect(validateOpenAPI31Document(document)).toBeNull();
      const validate = compileOpenAPI31Schema(document, SCHEMA);
      expect(validate({ value: "expected" })).toBe(true);
      expect(validate({ value: 42 })).toBe(false);
      expect(document).toStrictEqual(original);
    },
  );

  it("excludes document-level annotation identifiers from the compilation registry", () => {
    const document = {
      ...documentWith({ type: "string" }),
      "x-note": { nested: { $id: SCHEMA, type: "number" } },
    };
    const original = structuredClone(document);
    expect(validateOpenAPI31Document(document)).toBeNull();
    const validate = compileOpenAPI31Schema(document, SCHEMA);
    expect(validate("expected")).toBe(true);
    expect(validate(42)).toBe(false);
    expect(document).toStrictEqual(original);
  });

  it.each(["const", "enum"])("preserves literal assertion data under %s", (keyword) => {
    const literal = { $id: SCHEMA, $anchor: "literal data", nullable: true };
    const document = documentWith({
      [keyword]: keyword === "enum" ? [literal] : literal,
    });
    const original = structuredClone(document);
    const validate = compileOpenAPI31Schema(document, SCHEMA);
    expect(validate(literal)).toBe(true);
    expect(validate({ ...literal, nullable: false })).toBe(false);
    expect(document).toStrictEqual(original);
  });

  it("still rejects identifiers on actual nested schemas", () => {
    for (const keyword of ["$id", "$anchor"]) {
      expect(
        validateOpenAPI31Document(
          documentWith({
            type: "object",
            properties: { value: { [keyword]: "unsupported", type: "string" } },
          }),
        ),
      ).toMatch(/Unsupported schema resource keyword/);
    }
  });

  it.each([
    [{ type: "string", nullable: true }, false, true],
    [{ type: "null", nullable: false }, true, false],
    [{ type: ["string", "null"], nullable: false }, true, true],
    [{ anyOf: [{ type: "string" }, { type: "null" }], nullable: false }, true, true],
    [{ type: "string", nullable: { arbitrary: "annotation" } }, false, true],
  ])(
    "uses only OpenAPI 3.1 assertions to decide null acceptance",
    (schema, acceptsNull, acceptsString) => {
      const document = documentWith(schema);
      const original = structuredClone(document);
      expect(validateOpenAPI31Document(document)).toBeNull();
      const validate = compileOpenAPI31Schema(document, SCHEMA);
      expect(validate(null)).toBe(acceptsNull);
      expect(validate("expected")).toBe(acceptsString);
      expect(validate(42)).toBe(false);
      expect(document).toStrictEqual(original);
    },
  );

  it("preserves properties whose names look like annotation keywords", () => {
    const document = documentWith({
      type: "object",
      properties: {
        nullable: { type: "string", nullable: true },
        example: { type: "string" },
        "x-note": { type: "string" },
      },
      required: ["nullable", "example", "x-note"],
    });
    const original = structuredClone(document);
    const validate = compileOpenAPI31Schema(document, SCHEMA);
    const valid = { nullable: "expected", example: "expected", "x-note": "expected" };
    expect(validate(valid)).toBe(true);
    expect(validate({ ...valid, nullable: null })).toBe(false);
    expect(validate({ ...valid, example: 42 })).toBe(false);
    expect(validate({ ...valid, "x-note": 42 })).toBe(false);
    expect(document).toStrictEqual(original);
  });

  it("keeps component registries separate between documents", () => {
    const strings = compileOpenAPI31Schema(documentWith({ type: "string" }), SCHEMA);
    const numbers = compileOpenAPI31Schema(documentWith({ type: "number" }), SCHEMA);
    expect(strings("value")).toBe(true);
    expect(numbers("value")).toBe(false);
    expect(numbers(1)).toBe(true);
    expect(strings(1)).toBe(false);
  });

  it("never coerces, inserts defaults, or removes additional properties", () => {
    const document = documentWith({
      type: "object",
      properties: { count: { type: "integer" }, note: { type: "string", default: "inserted" } },
      required: ["count"],
      additionalProperties: false,
    });
    const before = structuredClone(document);
    const validate = compileOpenAPI31Schema(document, SCHEMA);
    for (const [value, expected] of [
      [{ count: 1 }, true],
      [{ count: "1" }, false],
      [{ count: 1, extra: true }, false],
    ] as const) {
      const original = structuredClone(value);
      expect(validate(value)).toBe(expected);
      expect(value).toStrictEqual(original);
    }
    expect(document).toStrictEqual(before);
  });
});

describe("OpenAPI schema resource provenance", () => {
  const hashes = {
    "schema.json": "1b8ccc6e34234b17536f2dd0eb3597142a32bd108438cd42471a5fca4c1a07ef",
    "meta.json": "267a88226e64e96dfc8c89dbd7e863160c84715e0fb893ca1d9fbf9f830f1f54",
    "dialect.json": "8a0e89e365dadbebce2921ce6244340c1090e9d544c60d977e9ad6b97a61227b",
    "meta-2024-11-10.json": "80706a9a404affedbf84ac4dc1328c9ce0d2a00804cdfc4d95c0ddd0053121dd",
    "dialect-2024-11-10.json": "647f32dfff64949d5020a28ecd1af4ffeffb1e9c695f861a52255a8004e07460",
    LICENSE: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
  };

  it.each(Object.entries(hashes))("retains upstream bytes for %s", (file, hash) => {
    const bytes = readFileSync(new URL(`3.1/${file}`, FIXTURES));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
  });
});
