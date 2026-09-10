import { describe, expect, it } from "vitest";
import { createArtifactEmitter, payloadOf, textPayloadOf } from "../utils/artifacts.js";
import { emitAvro, fieldNamed } from "../utils/avro.js";
import { targetText } from "../utils/diagnostics.js";
import { createLibraryTester } from "../utils/emitter-package.js";
import { expectDescriptorParity } from "../utils/protobuf-parity.js";
import { resolveRef } from "../utils/json-pointer.js";
import { avroType, protobufType, readAvro, readProtobuf } from "../utils/binary-evolution.js";
import type { AsyncAPIDocument } from "#emitter/types/index.js";
import { util as protobufUtil } from "protobufjs";

type Dialect = "avro" | "protobuf";

function source(dialect: Dialect, fields: string, declarations = "", modelMetadata = ""): string {
  return `
    @service namespace Test;
    ${dialect === "avro" ? '@Avro.avroNamespace("contract")' : '@Protobuf.package({ name: "contract" })'}
    namespace Wire {
      ${declarations}
      @message ${dialect === "avro" ? "@Avro.avroRecord" : "@Protobuf.message"}
      ${modelMetadata}
      model Event { ${fields} }
    }
    @channel("events") interface Events { @send op send(event: Wire.Event): void; }
  `;
}

const metadataCases = [
  ["F01 minLength property", "@minLength(2)", "string", "@minLength"],
  ["F01 maxLength property", "@maxLength(5)", "string", "@maxLength"],
  ["F01 pattern property", '@pattern("^[A-Z]+$")', "string", "@pattern"],
  ["F01 format property", '@format("uuid")', "string", "@format"],
  ["F02 inclusive minimum", "@minValue(2)", "int32", "@minValue"],
  ["F02 inclusive maximum", "@maxValue(10)", "int32", "@maxValue"],
  ["F02 exclusive minimum", "@minValueExclusive(2)", "int32", "@minValueExclusive"],
  ["F02 exclusive maximum", "@maxValueExclusive(10)", "int32", "@maxValueExclusive"],
  ["F03 minItems property", "@minItems(1)", "string[]", "@minItems"],
  ["F03 maxItems property", "@maxItems(3)", "string[]", "@maxItems"],
  ["F05 integer encoding", "@encode(string)", "int32", "@encode"],
  ["F05 bytes encoding", '@encode("base64url")', "bytes", "@encode"],
  ["F10 invisible", "@invisible(Lifecycle)", "string", "restricted lifecycle visibility"],
  [
    "F10 partial visibility",
    "@visibility(Lifecycle.Read)",
    "string",
    "restricted lifecycle visibility",
  ],
] as const;

for (const dialect of ["avro", "protobuf"] as const) {
  const library = dialect === "avro" ? "tsp-avro" : "@typespec/protobuf";
  const emitter = createArtifactEmitter(library, dialect);
  const field = (declaration: string, tag = 1) => {
    const decorator = dialect === "protobuf" ? `@Protobuf.field(${String(tag)})` : "";
    return `${decorator} ${declaration}`;
  };

  describe(`Binary fidelity: generated ${dialect}`, () => {
    it("F10 refuses user constraints augmenting a built-in scalar", async () => {
      const code = source(dialect, field("value: string;"), "@@minLength(TypeSpec.string, 2);");
      await createLibraryTester(library).compile(code);
      const result = await emitter.emit(code);
      expect(result.doc).toBeNull();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        code: `tsp-asyncapi/${dialect}-artifact-unavailable`,
        severity: "error",
      });
      expect(result.diagnostics[0].message).toContain("@minLength");
    });

    it.each(metadataCases)(
      "%s refuses compiler-accepted lossy metadata",
      async (_, metadata, type, reason) => {
        const code = source(dialect, field(`${metadata} value: ${type};`));
        // The compiler accepts the source before the artifact converter runs.
        await createLibraryTester(library).compile(code);
        const result = await emitter.emit(code);
        expect(result.doc).toBeNull();
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toMatchObject({
          code: `tsp-asyncapi/${dialect}-artifact-unavailable`,
          severity: "error",
        });
        expect(result.diagnostics[0].message).toContain(reason);
        expect(result.diagnostics[0].message).toContain("binary wire type");
        expect(targetText(result.diagnostics[0])).toContain(
          dialect === "avro" ? "model Event" : "value:",
        );
      },
    );

    it.each([
      [
        "F01 scalar-chain constraint",
        "@minLength(2) scalar Text extends string; scalar Derived extends Text;",
        "Derived",
        "@minLength",
        "scalar Text",
      ],
      [
        "F05 scalar-chain encoding",
        "@encode(string) scalar Number extends int32; scalar Derived extends Number;",
        "Derived",
        "@encode",
        "scalar Number",
      ],
      [
        "F03 named collection constraint",
        "@maxItems(3) model Names is string[];",
        "Names",
        "@maxItems",
        "model Names",
      ],
      [
        "F06 discriminated envelope",
        "@discriminated union Choice { a: A, b: B } model A { a: string; } model B { b: string; }",
        "Choice",
        "@discriminated",
        "union Choice",
      ],
      [
        "F06 model discriminator",
        `@discriminator("kind") model Base { ${field("kind: string;")} }`,
        "Base",
        "@discriminator",
        "model Base",
      ],
    ])("%s refuses reached declarations", async (_, declarations, type, reason, target) => {
      const code = source(dialect, field(`value: ${type};`), declarations);
      await createLibraryTester(library).compile(code);
      const result = await emitter.emit(code);
      expect(result.doc).toBeNull();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        code: `tsp-asyncapi/${dialect}-artifact-unavailable`,
        severity: "error",
      });
      expect(result.diagnostics[0].message).toContain(reason);
      expect(targetText(result.diagnostics[0])).toContain(
        dialect === "avro" ? "model Event" : target,
      );
    });

    it("F08 keeps separate native headers and the actual generated binary payload", async () => {
      const code = source(
        dialect,
        field('@encodedName("application/json", "json_id") source_id: string;') +
          field("note?: string;", 2),
        'model Headers { @encodedName("application/json", "trace_id") traceId: string; }',
        "@headers(Headers)",
      );
      const doc = await emitter.emitClean(code);
      await expect(doc).toBeValidAsyncAPI();
      const message = doc.components?.messages?.Event;
      expect(message?.headers).toEqual({ $ref: "#/components/schemas/Wire.Headers" });
      expect(resolveRef(doc, "#/components/schemas/Wire.Headers")).toMatchObject({
        type: "object",
        properties: { trace_id: { type: "string" } },
        required: ["trace_id"],
      });
      const payload = payloadOf(doc, "Event");
      if (dialect === "avro") {
        expect(payload.schemaFormat).toBe("application/vnd.apache.avro;version=1.9.0");
        expect(readAvro(payload.schema, payload.schema, { source_id: "e" })).toMatchObject({
          status: "decoded",
          value: { source_id: "e", note: null },
          ownFields: ["note", "source_id"],
        });
        expect(readAvro(payload.schema, payload.schema, { source_id: 3 })).toMatchObject({
          status: "rejected",
          phase: "writer",
        });
      } else {
        const text = textPayloadOf(doc, "Event").schema;
        expect(payload.schemaFormat).toBe("application/vnd.google.protobuf;version=3");
        expect(readProtobuf(text, text, "contract.Event", { source_id: "e" })).toMatchObject({
          status: "decoded",
          value: { source_id: "e" },
          ownFields: ["source_id"],
        });
        expect(readProtobuf(text, text, "contract.Event", { source_id: 3 })).toMatchObject({
          status: "rejected",
          phase: "writer",
        });
      }
    });

    it("F08 refuses lifted headers instead of converting a different binary payload", async () => {
      const result = await emitter.emit(
        source(dialect, field("@header trace: string;") + field("value: string;", 2)),
      );
      expect(result.doc).toBeNull();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        code: "tsp-asyncapi/header-on-generated-payload",
        severity: "error",
      });
      expect(targetText(result.diagnostics[0])).toContain("trace:");
    });

    it("F10 accepts unconstrained custom scalars, all lifecycle phases, docs and JSON-only names", async () => {
      const doc = await emitter.emitClean(
        source(
          dialect,
          field(
            '@doc("Wire identifier") @encodedName("application/json", "json_id") @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update, Lifecycle.Delete, Lifecycle.Query) source_id: Id;',
          ),
          "scalar Id extends string;",
        ),
      );
      const payload = payloadOf(doc, "Event");
      const result =
        dialect === "avro"
          ? readAvro(payload.schema, payload.schema, { source_id: "exact" })
          : readProtobuf(
              textPayloadOf(doc, "Event").schema,
              textPayloadOf(doc, "Event").schema,
              "contract.Event",
              { source_id: "exact" },
            );
      expect(result).toMatchObject({
        status: "decoded",
        value: { source_id: "exact" },
        ownFields: ["source_id"],
      });
    });

    it("F09 validates the actual binary payload after JSON document serialization too", async () => {
      const emitted = await createLibraryTester(library)
        .emit("tsp-asyncapi", {
          "preview-features": [dialect],
          "file-type": "json",
        })
        .compile(source(dialect, field("id: string;")));
      const doc = JSON.parse(emitted.outputs["asyncapi.json"]) as AsyncAPIDocument;
      await expect(doc).toBeValidAsyncAPI();
      const payload = payloadOf(doc, "Event");
      const result =
        dialect === "avro"
          ? readAvro(payload.schema, payload.schema, { id: "json-output" })
          : readProtobuf(
              textPayloadOf(doc, "Event").schema,
              textPayloadOf(doc, "Event").schema,
              "contract.Event",
              { id: "json-output" },
            );
      expect(result).toMatchObject({ status: "decoded", value: { id: "json-output" } });
    });
  });
}

describe("Binary-specific refusal and codec controls", () => {
  it("F04 preserves Avro nested default names instead of applying JSON-only encoded names", async () => {
    const declarations =
      'model Inner { @encodedName("application/json", "json_id") source_id: string; }';
    const fields = `
      inner: Inner = #{source_id: "default"};
      list: Inner[] = #[#{source_id: "item"}];
      lookup: Record<Inner> = #{one: #{source_id: "mapped"}};
    `;
    const result = await emitAvro(`
      @Avro.avroNamespace("contract") namespace Wire {
        ${declarations}
        @Avro.avroRecord model Event { ${fields} }
      }
    `);
    expect(result.diagnostics).toEqual([]);
    const schema = result.files["contract/Event.avsc"];
    expect(fieldNamed(schema, "inner").default).toEqual({ source_id: "default" });
    expect(fieldNamed(fieldNamed(schema, "inner").type, "source_id").name).toBe("source_id");
    const doc = await createArtifactEmitter("tsp-avro", "avro").emitClean(
      source("avro", fields, declarations),
    );
    const generated = payloadOf(doc, "Event").schema;
    expect(generated).toEqual(schema);
    await expect(doc).toBeValidAsyncAPI();
    expect(readAvro(generated, generated, {})).toMatchObject({
      status: "decoded",
      value: {
        inner: { source_id: "default" },
        list: [{ source_id: "item" }],
        lookup: { one: { source_id: "mapped" } },
      },
    });
  });

  it("F02–F07 generated Avro preserves hand-authored values and rejects one-fault witnesses", async () => {
    const doc = await createArtifactEmitter("tsp-avro", "avro").emitClean(
      source(
        "avro",
        'id: string; requiredNullable: string | null; optionalNullable?: string | null; count: int32; values: string[]; lookup: Record<int32>; state: State; next?: Node; note: string = "fallback";',
        "enum State { A, B } model Node { id: string; next?: Node; }",
      ),
    );
    await expect(doc).toBeValidAsyncAPI();
    const schema = payloadOf(doc, "Event").schema;
    const input = {
      id: "e",
      requiredNullable: null,
      count: 2147483647,
      values: ["a", "b"],
      lookup: { x: 1 },
      state: "B",
      next: { id: "child", next: null },
    };
    const expected = { ...input, optionalNullable: null, note: "fallback" };
    expect(readAvro(schema, schema, input)).toMatchObject({ status: "decoded", value: expected });
    for (const override of [
      { id: undefined },
      { requiredNullable: undefined },
      { count: 2147483648 },
      { count: 1.5 },
      { values: [1] },
      { lookup: { x: "wrong" } },
      { state: "C" },
      { optionalNullable: 42 },
    ]) {
      expect(readAvro(schema, schema, { ...input, ...override })).toMatchObject({
        status: "rejected",
        phase: "writer",
      });
    }
    for (const count of [-2147483648, -1, 0, 1, 2147483647]) {
      expect(readAvro(schema, schema, { ...input, count })).toMatchObject({
        status: "decoded",
        value: { ...expected, count },
      });
    }
    expect(
      readAvro(schema, schema, {
        ...input,
        requiredNullable: "present",
        optionalNullable: "present",
      }),
    ).toMatchObject({
      status: "decoded",
      value: { ...expected, requiredNullable: "present", optionalNullable: "present" },
    });
    expect(readAvro(schema, schema, { ...input, undeclared: "lost" })).toMatchObject({
      status: "decoded",
      value: expected,
    });
  });

  it("F02–F07 generated protobuf preserves declared collections, bytes and exact long representations", async () => {
    const doc = await createArtifactEmitter("@typespec/protobuf", "protobuf").emitClean(
      source(
        "protobuf",
        "@Protobuf.field(1) id: string; @Protobuf.field(2) count?: int32; @Protobuf.field(3) values: string[]; @Protobuf.field(4) lookup: Protobuf.Map<string, int32>; @Protobuf.field(5) data: bytes; @Protobuf.field(6) wide: int64; @Protobuf.field(7) state: State;",
        "enum State { A: 0, B: 1 }",
      ),
    );
    await expect(doc).toBeValidAsyncAPI();
    const text = textPayloadOf(doc, "Event").schema;
    const input = {
      id: "e",
      count: 0,
      values: ["a", "b"],
      lookup: { x: 1 },
      data: Buffer.from([0, 255]),
      wide: new protobufUtil.Long(-1, 2147483647, false),
      state: 1,
    };
    const expected = { ...input, data: [0, 255], wide: "9223372036854775807" };
    expect(readProtobuf(text, text, "contract.Event", input)).toMatchObject({
      status: "decoded",
      value: expected,
      unknownEnums: [],
    });
    for (const override of [
      { id: 42 },
      { count: 1.5 },
      { values: [1] },
      { lookup: { x: "wrong" } },
    ]) {
      expect(readProtobuf(text, text, "contract.Event", { ...input, ...override })).toMatchObject({
        status: "rejected",
        phase: "writer",
      });
    }
    for (const count of [-2147483648, -1, 0, 1, 2147483647]) {
      expect(readProtobuf(text, text, "contract.Event", { ...input, count })).toMatchObject({
        status: "decoded",
        value: { ...expected, count },
      });
    }
    // protobufjs verifies integer-ness, not the full int32 source range.
    expect(
      readProtobuf(text, text, "contract.Event", { ...input, count: 2147483648 }),
    ).toMatchObject({
      status: "decoded",
      value: { ...expected, count: -2147483648 },
    });
    expect(readProtobuf(text, text, "contract.Event", { ...input, state: 42 })).toMatchObject({
      status: "decoded",
      value: { ...expected, state: 42 },
      readerVerification: null,
      unknownEnums: ["state"],
    });
    expect(
      readProtobuf(text, text, "contract.Event", { ...input, undeclared: "lost" }),
    ).toMatchObject({
      status: "decoded",
      value: expected,
    });
  });

  it("F07 refuses protobuf inheritance that previously omitted accepted base fields", async () => {
    const code = source(
      "protobuf",
      "@Protobuf.field(2) own: string;",
      "model Base { @Protobuf.field(1) inherited: string; }",
    ).replace("model Event {", "model Event extends Base {");
    await createLibraryTester("@typespec/protobuf").compile(code);
    const result = await createArtifactEmitter("@typespec/protobuf", "protobuf").emit(code);
    expect(result.doc).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "tsp-asyncapi/protobuf-artifact-unavailable",
      severity: "error",
    });
    expect(result.diagnostics[0].message).toContain("inheritance whose base fields would be lost");
    expect(targetText(result.diagnostics[0])).toContain("model Event extends Base");
  });

  it.each(["model Names is string[];", "model Names is Record<string>;"])(
    "F03 refuses protobuf indexed models rather than emitting an empty message: %s",
    async (declaration) => {
      const code = source("protobuf", "@Protobuf.field(1) values: Names;", declaration);
      await createLibraryTester("@typespec/protobuf").compile(code);
      const result = await createArtifactEmitter("@typespec/protobuf", "protobuf").emit(code);
      expect(result.doc).toBeNull();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].message).toContain("index signature whose values would be lost");
      expect(targetText(result.diagnostics[0])).toContain("model Names");
    },
  );

  it("F04 refuses explicit proto3 source defaults, including a scalar-zero default", async () => {
    for (const declaration of ['value: string = "reader";', 'value: string = "";']) {
      const code = source("protobuf", `@Protobuf.field(1) ${declaration}`);
      await createLibraryTester("@typespec/protobuf").compile(code);
      const result = await createArtifactEmitter("@typespec/protobuf", "protobuf").emit(code);
      expect(result.doc).toBeNull();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        code: "tsp-asyncapi/protobuf-artifact-unavailable",
        severity: "error",
      });
      expect(result.diagnostics[0].message).toContain("explicit TypeSpec default");
      expect(targetText(result.diagnostics[0])).toContain("value:");
    }
  });

  it("F10 direct Avro diagnostics retain each reason once on a reused constrained scalar", async () => {
    const result = await emitAvro(`
      @Avro.avroNamespace("contract") namespace Wire {
        @minLength(2) @pattern("^[A-Z]+$") scalar Code extends string;
        @Avro.avroRecord model Event { first: Code; second: Code; }
      }
    `);
    expect(result.files).toEqual({});
    expect(result.diagnostics).toHaveLength(2);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic).toMatchObject({ code: "tsp-avro/unsupported-type", severity: "error" });
      expect(targetText(diagnostic)).toContain("scalar Code");
    }
    expect(result.diagnostics.map((d) => d.message).join("\n")).toContain("@minLength");
    expect(result.diagnostics.map((d) => d.message).join("\n")).toContain("@pattern");
  });

  it("F10 protobuf keeps distinct metadata reasons on one property", async () => {
    const result = await createArtifactEmitter("@typespec/protobuf", "protobuf").emit(
      source("protobuf", '@Protobuf.field(1) @minLength(2) @pattern("^[A-Z]+$") value: string;'),
    );
    expect(result.doc).toBeNull();
    expect(result.diagnostics).toHaveLength(2);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic).toMatchObject({
        code: "tsp-asyncapi/protobuf-artifact-unavailable",
        severity: "error",
      });
      expect(targetText(diagnostic)).toContain("value:");
    }
  });

  it("F10 pins logical annotation units, decimal scale and fixed width separately from avsc decoding", async () => {
    const result = await emitAvro(`
      @Avro.avroNamespace("contract") namespace Wire {
        @Avro.fixed(4) @Avro.decimal(8, 2) scalar Amount extends bytes;
        @Avro.avroRecord model Event {
          @Avro.logicalType("timestamp-millis") at: int64;
          amount: Amount;
          @Avro.logicalType("uuid") id: string;
        }
      }
    `);
    expect(result.diagnostics).toEqual([]);
    const schema = result.files["contract/Event.avsc"];
    expect(fieldNamed(schema, "at").type).toEqual({
      type: "long",
      logicalType: "timestamp-millis",
    });
    expect(fieldNamed(schema, "amount").type).toEqual({
      type: "fixed",
      name: "Amount",
      namespace: "contract",
      size: 4,
      logicalType: "decimal",
      precision: 8,
      scale: 2,
    });
    expect(fieldNamed(schema, "id").type).toEqual({ type: "string", logicalType: "uuid" });
    const value = { at: 1234, amount: Buffer.from([0, 0, 4, 210]), id: "not-a-uuid" };
    // No logical adapter: the bytes encode unscaled 1234, not a JS decimal.
    expect(readAvro(schema, schema, value)).toMatchObject({ status: "decoded", value });
    expect(readAvro(schema, schema, { ...value, amount: Buffer.from([1]) })).toMatchObject({
      status: "rejected",
      phase: "writer",
    });
  });

  it.each(["local-timestamp-millis", "local-timestamp-micros"])(
    "F10 refuses %s outside advertised Avro 1.9",
    async (logicalType) => {
      const result = await createArtifactEmitter("tsp-avro", "avro").emit(
        source("avro", `@Avro.logicalType("${logicalType}") at: int64;`),
      );
      expect(result.doc).toBeNull();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        code: "tsp-asyncapi/avro-artifact-unavailable",
        severity: "error",
      });
      expect(result.diagnostics[0].message).toContain("not a logical type Avro 1.9 defines");
    },
  );

  it("F09 rejects malformed authored schemas and an explicit missing protobuf root", () => {
    expect(() => avroType({ type: "not-avro" })).toThrow();
    expect(() =>
      protobufType('syntax = "proto3"; message Broken { string x = ; }', "Broken"),
    ).toThrow();
    expect(() => protobufType('syntax = "proto3"; message Event {}', "Missing")).toThrow(
      /no such type/,
    );
  });

  it("F09 authored proto2 enforces wire requiredness and materializes scalar defaults only on access", () => {
    const text =
      'syntax = "proto2"; message Event { required string id = 1; optional int32 count = 2 [default = 7]; }';
    expect(readProtobuf(text, text, "Event", {})).toMatchObject({
      status: "rejected",
      phase: "writer",
    });
    expect(readProtobuf(text, text, "Event", { id: "e" })).toMatchObject({
      status: "decoded",
      value: { id: "e" },
      ownFields: ["id"],
    });
    const type = protobufType(text, "Event");
    const decoded = type.decode(type.encode({ id: "e" }).finish()) as unknown as Record<
      string,
      unknown
    >;
    expect(decoded.count).toBe(7);
    expect(Object.hasOwn(decoded, "count")).toBe(false);
  });

  it("F09 selects a mutually recursive protobuf root explicitly and keeps the official emitter parity oracle", async () => {
    const code = `
      @Protobuf.package({ name: "contract" }) namespace Wire {
        @Protobuf.message model Event { @Protobuf.field(1) id: string; @Protobuf.field(2) next?: Other; }
        @Protobuf.message model Other { @Protobuf.field(1) event?: Event; }
      }
    `;
    await expectDescriptorParity(code, "Event");
    const text =
      'syntax = "proto3"; package contract; message Other { Event event = 1; } message Event { string id = 1; Other next = 2; }';
    expect(
      readProtobuf(text, text, "contract.Event", { id: "root", next: { event: { id: "child" } } }),
    ).toMatchObject({
      status: "decoded",
      value: { id: "root", next: { event: { id: "child" } } },
    });
  });
});
