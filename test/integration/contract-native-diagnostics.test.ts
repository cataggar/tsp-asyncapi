import { describe, expect, it } from "vitest";
import { emitDocument, emitDocumentWithDiagnostics } from "../utils/test-host.js";
import { targetText } from "../utils/diagnostics.js";
import { createMessageValidator } from "../utils/payload-validation.js";

const channel = '@channel("events") interface Events { @send op send(event: Event): void; }';

describe("Native fidelity: accepted-source reproductions", () => {
  it("F10 opaque scalar warns once, retaining an explicitly unconstrained shape", async () => {
    const source = `scalar Opaque; scalar Derived extends Opaque;
      @message model Event { a: Derived; b: Derived; } ${channel}`;
    for (let compile = 0; compile < 2; compile++) {
      const { doc, diagnostics } = await emitDocumentWithDiagnostics(source);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "tsp-asyncapi/unmapped-schema-scalar",
        severity: "warning",
      });
      expect(targetText(diagnostics[0])).toContain("scalar Opaque");
      expect(diagnostics[0].message).toContain("extends");
      expect(doc).not.toBeNull();
    }
  });

  it("F10 unknown and supported encoded scalars are positive controls", async () => {
    const doc = await emitDocument(`@message model Event {
      anything: unknown; epoch: unixTimestamp32;
    } ${channel}`);
    expect(
      createMessageValidator(doc, "Event").validate({
        payload: { anything: { arbitrary: true }, epoch: 123 },
      }).accepted,
    ).toBe(true);
  });

  it("F05 augmented builtin constraints are diagnosed after scalar encoding", async () => {
    const { doc, diagnostics } = await emitDocumentWithDiagnostics(`
      @@minValue(TypeSpec.int32, 1);
      @@encode(TypeSpec.int32, string);
      @message model Event { value: int32; } ${channel}
    `);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "tsp-asyncapi/unsupported-encoded-constraint",
      severity: "warning",
    });
    expect(diagnostics[0].message).toContain("minimum");
    if (!doc) throw new Error("Expected warned output");
    const validator = createMessageValidator(doc, "Event");
    expect(validator.validate({ payload: { value: "2" } }).accepted).toBe(true);
    expect(validator.validate({ payload: { value: 2 } }).accepted).toBe(false);
  });

  it.each([
    ["property", "", "@minValue(1) @maxValue(10) @encode(string) value: int32;", 2],
    [
      "scalar chain",
      "@minValue(1) scalar Base extends int32; @maxValue(10) scalar Derived extends Base;",
      "@encode(string) value: Derived;",
      2,
    ],
    [
      "allOf spine",
      "@minValue(1) scalar Base extends int32; @minValue(2) scalar Derived extends Base;",
      "@encode(string) value: Derived;",
      1,
    ],
    [
      "nullable union",
      "@minValue(1) scalar Base extends int32;",
      "@encode(string) value: Base | null;",
      1,
    ],
  ])(
    "F05 %s diagnoses discarded source bounds without contradictory wire types",
    async (_, declarations, fields, count) => {
      const { doc, diagnostics } = await emitDocumentWithDiagnostics(
        `${declarations} @message model Event { ${fields} } ${channel}`,
      );
      expect(diagnostics).toHaveLength(count);
      for (const diagnostic of diagnostics) {
        expect(diagnostic).toMatchObject({
          code: "tsp-asyncapi/unsupported-encoded-constraint",
          severity: "warning",
        });
        expect(targetText(diagnostic)).toContain("value:");
        expect(diagnostic.message).toMatch(/minimum|maximum/);
      }
      expect(doc).not.toBeNull();
      if (!doc) throw new Error("Expected warned output");
      const validator = createMessageValidator(doc, "Event");
      expect(validator.validate({ payload: { value: "2" } }).accepted).toBe(true);
      expect(validator.validate({ payload: { value: 2 } }).accepted).toBe(false);
      expect(validator.validate({ payload: { value: "outside-source-range" } }).accepted).toBe(
        true,
      );
    },
  );

  it.each([
    ["unevaluatedProperties", "false"],
    ["dependentRequired", '#{ id: #["name"] }'],
    ["prefixItems", '#[#{ type: "string" }]'],
  ])("F09 %s is retained but warned as non-draft07", async (keyword, value) => {
    const { doc, diagnostics } = await emitDocumentWithDiagnostics(
      `@message @jsonSchemaExtension("${keyword}", ${value})
       model Event { id: string; } ${channel}`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "tsp-asyncapi/unsupported-schema-keyword",
      severity: "warning",
    });
    expect(diagnostics[0].message).toContain(keyword);
    expect(targetText(diagnostics[0])).toContain("model Event");
    expect(doc).not.toBeNull();
    if (!doc) throw new Error("Expected warned output");
    expect(() => createMessageValidator(doc, "Event")).toThrow();
  });

  it.each([
    ["type", '"not-a-type"'],
    ["minLength", "-1"],
    ["required", '#["id", "id"]'],
    ["properties", '#{ nested: #{ type: "not-a-type" } }'],
    ["pattern", '"["'],
  ])("F10 invalid %s refuses emitted output", async (keyword, value) => {
    const { doc, diagnostics } = await emitDocumentWithDiagnostics(
      `@message @jsonSchemaExtension("${keyword}", ${value})
       model Event { id: string; } ${channel}`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "tsp-asyncapi/invalid-schema-extension",
      severity: "error",
    });
    expect(diagnostics[0].message).toContain(keyword);
    expect(targetText(diagnostics[0])).toContain("model Event");
    expect(doc).toBeNull();
  });

  it("F10 valid overrides warn; annotations and equal values do not", async () => {
    const { doc, diagnostics } = await emitDocumentWithDiagnostics(
      `@message @jsonSchemaExtension("required", #[])
       @jsonSchemaExtension("type", "object")
       @jsonSchemaExtension("x-note", "authored")
       model Event { id: string; } ${channel}`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "tsp-asyncapi/schema-extension-overrides-contract",
      severity: "warning",
    });
    expect(diagnostics[0].message).toContain("required");
    if (!doc) throw new Error("Expected warned output");
    expect(createMessageValidator(doc, "Event").validate({ payload: {} }).accepted).toBe(true);
  });

  it("F10 replacing a property's reference wrapper is an explicit contract override", async () => {
    const { doc, diagnostics } = await emitDocumentWithDiagnostics(`
      model Value { id: string; }
      @message model Event {
        @jsonSchemaExtension("allOf", #[#{ type: "object" }]) value: Value;
      } ${channel}
    `);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "tsp-asyncapi/schema-extension-overrides-contract",
      severity: "warning",
    });
    expect(diagnostics[0].message).toContain("allOf");
    expect(targetText(diagnostics[0])).toContain("value:");
    if (!doc) throw new Error("Expected warned output");
    expect(createMessageValidator(doc, "Event").validate({ payload: { value: {} } }).accepted).toBe(
      true,
    );
    const control = await emitDocument(`model Value { id: string; }
      @message model Event { value: Value; } ${channel}`);
    expect(
      createMessageValidator(control, "Event").validate({ payload: { value: {} } }).accepted,
    ).toBe(false);
  });
});
