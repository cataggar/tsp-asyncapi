import { beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { createArtifactEmitter, payloadOf, textPayloadOf } from "../utils/artifacts.js";
import { readAvro, readProtobuf, type BinaryReadResult } from "../utils/binary-evolution.js";
import { targetText } from "../utils/diagnostics.js";

interface Release {
  readonly fields: string;
  readonly declarations?: string;
  readonly metadata?: string;
}

type Expected =
  | { readonly value: Record<string, unknown>; readonly unknownEnums?: readonly string[] }
  | { readonly phase: "resolver" | "reader"; readonly reason: RegExp };

interface EvolutionCase {
  readonly name: string;
  readonly old: Release;
  readonly next: Release;
  readonly oldValue: Record<string, unknown>;
  readonly nextValue: Record<string, unknown>;
  /** old→old, old→new, new→old, new→new, from the source contract. */
  readonly expected: readonly [Expected, Expected, Expected, Expected];
}

const pairs = [
  { label: "old→old", writer: 0, reader: 0 },
  { label: "old→new", writer: 0, reader: 1 },
  { label: "new→old", writer: 1, reader: 0 },
  { label: "new→new", writer: 1, reader: 1 },
] as const;

function source(dialect: "avro" | "protobuf", release: Release): string {
  return `
    @service namespace Test;
    ${dialect === "avro" ? '@Avro.avroNamespace("contract")' : '@Protobuf.package({ name: "contract" })'}
    namespace Wire {
      ${release.declarations ?? ""}
      @message ${dialect === "avro" ? "@Avro.avroRecord" : "@Protobuf.message"}
      ${release.metadata ?? ""}
      model Event { ${release.fields} }
    }
    @channel("events") interface Events { @send op send(event: Wire.Event): void; }
  `;
}

const value = (fields: Record<string, unknown>, unknownEnums?: readonly string[]): Expected => ({
  value: fields,
  unknownEnums,
});
const missing: Expected = { phase: "resolver", reason: /no matching field.*default/i };
const incompatible: Expected = { phase: "resolver", reason: /cannot read/i };
const nullBranch: Expected = { phase: "resolver", reason: /cannot read "null" as "string"/i };
const enumBranch: Expected = { phase: "resolver", reason: /cannot read/i };

const avroCases: readonly EvolutionCase[] = [
  {
    name: "E01 optional addition: old reader loses the new field, new reader supplies null",
    old: { fields: "id: string;" },
    next: { fields: "id: string; note?: string;" },
    oldValue: { id: "e" },
    nextValue: { id: "e", note: "new" },
    expected: [
      value({ id: "e" }),
      value({ id: "e", note: null }),
      value({ id: "e" }),
      value({ id: "e", note: "new" }),
    ],
  },
  {
    name: "E01 optional addition: an omitted optional writer field normalizes to null",
    old: { fields: "id: string;" },
    next: { fields: "id: string; note?: string;" },
    oldValue: { id: "e" },
    nextValue: { id: "e" },
    expected: [
      value({ id: "e" }),
      value({ id: "e", note: null }),
      value({ id: "e" }),
      value({ id: "e", note: null }),
    ],
  },
  {
    name: "E02 required addition without a reader default refuses old writer resolution",
    old: { fields: "id: string;" },
    next: { fields: "id: string; note: string;" },
    oldValue: { id: "e" },
    nextValue: { id: "e", note: "new" },
    expected: [value({ id: "e" }), missing, value({ id: "e" }), value({ id: "e", note: "new" })],
  },
  {
    name: "E03 required addition with a reader default accepts by defaulting, not preservation",
    old: { fields: "id: string;" },
    next: { fields: 'id: string; note: string = "fallback";' },
    oldValue: { id: "e" },
    nextValue: { id: "e", note: "new" },
    expected: [
      value({ id: "e" }),
      value({ id: "e", note: "fallback" }),
      value({ id: "e" }),
      value({ id: "e", note: "new" }),
    ],
  },
  {
    name: "E04 optional→required: the old absent/null branch cannot be read",
    old: { fields: "id: string; note?: string;" },
    next: { fields: "id: string; note: string;" },
    oldValue: { id: "e" },
    nextValue: { id: "e", note: "common" },
    expected: [
      value({ id: "e", note: null }),
      nullBranch,
      value({ id: "e", note: "common" }),
      value({ id: "e", note: "common" }),
    ],
  },
  {
    name: "E04 required→optional: new absence is not accepted by the old required reader",
    old: { fields: "id: string; note: string;" },
    next: { fields: "id: string; note?: string;" },
    oldValue: { id: "e", note: "common" },
    nextValue: { id: "e", note: null },
    expected: [
      value({ id: "e", note: "common" }),
      value({ id: "e", note: "common" }),
      nullBranch,
      value({ id: "e", note: null }),
    ],
  },
  {
    name: "E04 optionality change refuses the nullable writer schema even for a present common value",
    old: { fields: "note?: string;" },
    next: { fields: "note: string;" },
    oldValue: { note: "common" },
    nextValue: { note: "common" },
    expected: [
      value({ note: "common" }),
      nullBranch,
      value({ note: "common" }),
      value({ note: "common" }),
    ],
  },
  {
    name: "E05 optional removal: skip old writer data and restore an old-reader null default",
    old: { fields: "id: string; note?: string;" },
    next: { fields: "id: string;" },
    oldValue: { id: "e", note: "old" },
    nextValue: { id: "e" },
    expected: [
      value({ id: "e", note: "old" }),
      value({ id: "e" }),
      value({ id: "e", note: null }),
      value({ id: "e" }),
    ],
  },
  {
    name: "E05 required removal: old reader has no default for the missing writer field",
    old: { fields: "id: string; note: string;" },
    next: { fields: "id: string;" },
    oldValue: { id: "e", note: "old" },
    nextValue: { id: "e" },
    expected: [value({ id: "e", note: "old" }), value({ id: "e" }), missing, value({ id: "e" })],
  },
  {
    name: "E06 rename without an alias fails both cross-version readers",
    old: { fields: "oldName: string;" },
    next: { fields: "newName: string;" },
    oldValue: { oldName: "same" },
    nextValue: { newName: "same" },
    expected: [value({ oldName: "same" }), missing, missing, value({ newName: "same" })],
  },
  {
    name: "E06 new-reader alias accepts the old name but cannot teach a frozen old reader",
    old: { fields: "oldName: string;" },
    next: { fields: '@Avro.aliases("oldName") newName: string;' },
    oldValue: { oldName: "same" },
    nextValue: { newName: "same" },
    expected: [
      value({ oldName: "same" }),
      value({ newName: "same" }),
      missing,
      value({ newName: "same" }),
    ],
  },
  {
    name: "E07 enum addition: common symbols survive, the new symbol has no old fallback",
    old: { declarations: "enum State { A, B }", fields: "state: State;" },
    next: { declarations: "enum State { A, B, C }", fields: "state: State;" },
    oldValue: { state: "A" },
    nextValue: { state: "C" },
    expected: [value({ state: "A" }), value({ state: "A" }), enumBranch, value({ state: "C" })],
  },
  {
    name: "E07 enum removal rejects the retired symbol instead of guessing one",
    old: { declarations: "enum State { A, B, C }", fields: "state: State;" },
    next: { declarations: "enum State { A, B }", fields: "state: State;" },
    oldValue: { state: "C" },
    nextValue: { state: "A" },
    expected: [value({ state: "C" }), enumBranch, value({ state: "A" }), value({ state: "A" })],
  },
  {
    name: "E07 enum reader fallback is accepted-with-default, not preserved new symbol",
    old: {
      declarations: '@Avro.enumDefault("UNKNOWN") enum State { UNKNOWN, A, B }',
      fields: "state: State;",
    },
    next: {
      declarations: '@Avro.enumDefault("UNKNOWN") enum State { UNKNOWN, A, B, C }',
      fields: "state: State;",
    },
    oldValue: { state: "A" },
    nextValue: { state: "C" },
    expected: [
      value({ state: "A" }),
      value({ state: "A" }),
      value({ state: "UNKNOWN" }),
      value({ state: "C" }),
    ],
  },
  {
    name: "E09 string→int refuses both cross-version resolver directions",
    old: { fields: "value: string;" },
    next: { fields: "value: int32;" },
    oldValue: { value: "42" },
    nextValue: { value: 42 },
    expected: [value({ value: "42" }), incompatible, incompatible, value({ value: 42 })],
  },
  {
    name: "E09 int→long promotion is directional even for a common small number",
    old: { fields: "value: int32;" },
    next: { fields: "value: int64;" },
    oldValue: { value: 42 },
    nextValue: { value: 42 },
    expected: [value({ value: 42 }), value({ value: 42 }), incompatible, value({ value: 42 })],
  },
  {
    name: "E09 long→int narrowing refuses the old writer schema",
    old: { fields: "value: int64;" },
    next: { fields: "value: int32;" },
    oldValue: { value: 2147483648 },
    nextValue: { value: 42 },
    expected: [
      value({ value: 2147483648 }),
      incompatible,
      value({ value: 42 }),
      value({ value: 42 }),
    ],
  },
  {
    name: "E09 nullable→nonnullable rejects the writer null branch at resolver construction",
    old: { fields: "value: string | null;" },
    next: { fields: "value: string;" },
    oldValue: { value: null },
    nextValue: { value: "common" },
    expected: [
      value({ value: null }),
      nullBranch,
      value({ value: "common" }),
      value({ value: "common" }),
    ],
  },
];

const protobufCases: readonly EvolutionCase[] = [
  {
    name: "E01 optional addition: unknown new tags are lost by the old reader",
    old: { fields: "@Protobuf.field(1) id: string;" },
    next: { fields: "@Protobuf.field(1) id: string; @Protobuf.field(2) note?: string;" },
    oldValue: { id: "e" },
    nextValue: { id: "e", note: "new" },
    expected: [
      value({ id: "e" }),
      value({ id: "e" }),
      value({ id: "e" }),
      value({ id: "e", note: "new" }),
    ],
  },
  {
    name: "E02 required source addition: wire decode succeeds without the new required own field",
    old: { fields: "@Protobuf.field(1) id: string;" },
    next: { fields: "@Protobuf.field(1) id: string; @Protobuf.field(2) note: string;" },
    oldValue: { id: "e" },
    nextValue: { id: "e", note: "new" },
    expected: [
      value({ id: "e" }),
      value({ id: "e" }),
      value({ id: "e" }),
      value({ id: "e", note: "new" }),
    ],
  },
  {
    name: "E04 optional→required source syntax still permits absent scalar wire data",
    old: { fields: "@Protobuf.field(1) note?: string;" },
    next: { fields: "@Protobuf.field(1) note: string;" },
    oldValue: {},
    nextValue: { note: "common" },
    expected: [value({}), value({}), value({ note: "common" }), value({ note: "common" })],
  },
  {
    name: "E04 required→optional does not create old-reader field presence",
    old: { fields: "@Protobuf.field(1) note: string;" },
    next: { fields: "@Protobuf.field(1) note?: string;" },
    oldValue: { note: "common" },
    nextValue: {},
    expected: [value({ note: "common" }), value({ note: "common" }), value({}), value({})],
  },
  {
    name: "E04 optional scalar-zero presence survives only the explicitly optional reader",
    old: { fields: "@Protobuf.field(1) count?: int32;" },
    next: { fields: "@Protobuf.field(1) count: int32;" },
    oldValue: { count: 0 },
    nextValue: { count: 0 },
    expected: [value({ count: 0 }), value({}), value({}), value({})],
  },
  {
    name: "E05 optional removal reserves the retired tag and loses unknown values",
    old: { fields: "@Protobuf.field(1) id: string; @Protobuf.field(2) note?: string;" },
    next: { fields: "@Protobuf.field(1) id: string;", metadata: '@Protobuf.reserve(2, "note")' },
    oldValue: { id: "e", note: "old" },
    nextValue: { id: "e" },
    expected: [
      value({ id: "e", note: "old" }),
      value({ id: "e" }),
      value({ id: "e" }),
      value({ id: "e" }),
    ],
  },
  {
    name: "E05 required removal decodes but violates the frozen old source-presence requirement",
    old: { fields: "@Protobuf.field(1) id: string; @Protobuf.field(2) note: string;" },
    next: { fields: "@Protobuf.field(1) id: string;", metadata: '@Protobuf.reserve(2, "note")' },
    oldValue: { id: "e", note: "old" },
    nextValue: { id: "e" },
    expected: [
      value({ id: "e", note: "old" }),
      value({ id: "e" }),
      value({ id: "e" }),
      value({ id: "e" }),
    ],
  },
  {
    name: "E06 stable-tag rename preserves a logical value through explicitly different field names",
    old: { fields: "@Protobuf.field(1) old_name: string;" },
    next: { fields: "@Protobuf.field(1) new_name: string;" },
    oldValue: { old_name: "same" },
    nextValue: { new_name: "same" },
    expected: [
      value({ old_name: "same" }),
      value({ new_name: "same" }),
      value({ old_name: "same" }),
      value({ new_name: "same" }),
    ],
  },
  {
    name: "E06 same-name tag change decodes successfully while losing the intended value",
    old: { fields: "@Protobuf.field(1) value: string;" },
    next: { fields: "@Protobuf.field(2) value: string;", metadata: "@Protobuf.reserve(1)" },
    oldValue: { value: "old" },
    nextValue: { value: "new" },
    expected: [value({ value: "old" }), value({}), value({}), value({ value: "new" })],
  },
  {
    name: "E07 enum addition retains an unknown number that fails a closed-enum consumer check",
    old: { declarations: "enum State { A: 0, B: 1 }", fields: "@Protobuf.field(1) state: State;" },
    next: {
      declarations: "enum State { A: 0, B: 1, C: 2 }",
      fields: "@Protobuf.field(1) state: State;",
    },
    oldValue: { state: 1 },
    nextValue: { state: 2 },
    expected: [
      value({ state: 1 }),
      value({ state: 1 }),
      value({ state: 2 }, ["state"]),
      value({ state: 2 }),
    ],
  },
  {
    name: "E07 enum removal retains the retired numeric value instead of a known symbol",
    old: {
      declarations: "enum State { A: 0, B: 1, C: 2 }",
      fields: "@Protobuf.field(1) state: State;",
    },
    next: { declarations: "enum State { A: 0, B: 1 }", fields: "@Protobuf.field(1) state: State;" },
    oldValue: { state: 2 },
    nextValue: { state: 1 },
    expected: [
      value({ state: 2 }),
      value({ state: 2 }, ["state"]),
      value({ state: 1 }),
      value({ state: 1 }),
    ],
  },
  {
    name: "E07 symbolic enum rename preserves numbers, not all language or ProtoJSON APIs",
    old: {
      declarations: "enum State { UNKNOWN: 0, OLD: 1 }",
      fields: "@Protobuf.field(1) state: State;",
    },
    next: {
      declarations: "enum State { UNKNOWN: 0, NEW: 1 }",
      fields: "@Protobuf.field(1) state: State;",
    },
    oldValue: { state: 1 },
    nextValue: { state: 1 },
    expected: [value({ state: 1 }), value({ state: 1 }), value({ state: 1 }), value({ state: 1 })],
  },
  {
    name: "E09 same-wire-type int32→sint32 changes values even though every decode succeeds",
    old: { fields: "@Protobuf.field(1) count: int32;" },
    next: { fields: "@Protobuf.field(1) count: Protobuf.sint32;" },
    oldValue: { count: 2 },
    nextValue: { count: 2 },
    expected: [value({ count: 2 }), value({ count: 1 }), value({ count: 4 }), value({ count: 2 })],
  },
  {
    name: "E09 int32→int64 widens old values but an old reader truncates a new wide value",
    old: { fields: "@Protobuf.field(1) count: int32;" },
    next: { fields: "@Protobuf.field(1) count: int64;" },
    oldValue: { count: 2147483647 },
    nextValue: { count: 2147483648 },
    expected: [
      value({ count: 2147483647 }),
      value({ count: "2147483647" }),
      value({ count: -2147483648 }),
      value({ count: "2147483648" }),
    ],
  },
];

function expectOutcome(result: BinaryReadResult, expected: Expected, protobuf: boolean): void {
  if ("phase" in expected) {
    expect(result).toMatchObject({ status: "rejected", phase: expected.phase });
    if (result.status === "rejected") expect(result.reason).toMatch(expected.reason);
    return;
  }
  expect(result.status).toBe("decoded");
  if (result.status !== "decoded") throw new Error(result.reason);
  expect(result.value).toEqual(expected.value);
  expect(result.ownFields).toEqual(Object.keys(expected.value).sort((a, b) => a.localeCompare(b)));
  if (protobuf) {
    expect(result.readerVerification).toBeNull();
    expect(result.unknownEnums).toEqual(expected.unknownEnums ?? []);
  }
}

for (const [dialect, cases] of [
  ["avro", avroCases],
  ["protobuf", protobufCases],
] as const) {
  const emitter = createArtifactEmitter(
    dialect === "avro" ? "tsp-avro" : "@typespec/protobuf",
    dialect,
  );
  for (const row of cases) {
    describe(`${dialect}: ${row.name}`, () => {
      let schemas: [unknown, unknown];
      beforeAll(async () => {
        // Separate compilations, not mutations of an emitted writer schema.
        const old = await emitter.emitClean(source(dialect, row.old));
        const next = await emitter.emitClean(source(dialect, row.next));
        schemas = [payloadOf(old, "Event").schema, payloadOf(next, "Event").schema];
      });
      it.each(pairs)("$label", ({ writer, reader }) => {
        const witness = writer === 0 ? row.oldValue : row.nextValue;
        const original = structuredClone(witness);
        const result =
          dialect === "avro"
            ? readAvro(schemas[writer], schemas[reader], witness)
            : readProtobuf(
                schemas[writer] as string,
                schemas[reader] as string,
                "contract.Event",
                witness,
              );
        expectOutcome(result, row.expected[writer * 2 + reader], dialect === "protobuf");
        expect(witness).toEqual(original);
      });
    });
  }
}

describe("Binary evolution limitations are asserted outcomes", () => {
  it.each(["avro", "protobuf"] as const)(
    "E08 %s constraints cannot become a misleading compatible binary matrix",
    async (dialect) => {
      const emitter = createArtifactEmitter(
        dialect === "avro" ? "tsp-avro" : "@typespec/protobuf",
        dialect,
      );
      for (const bound of [2, 3]) {
        const result = await emitter.emit(
          source(dialect, {
            fields: `${dialect === "protobuf" ? "@Protobuf.field(1)" : ""} @minLength(${String(bound)}) name: string;`,
          }),
        );
        expect(result.doc).toBeNull();
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toMatchObject({
          code: `tsp-asyncapi/${dialect}-artifact-unavailable`,
          severity: "error",
        });
        expect(result.diagnostics[0].message).toContain("@minLength");
      }
    },
  );

  it("E03 proto3 explicit defaults are unsupported, not an automatically installed migration adapter", async () => {
    const emitter = createArtifactEmitter("@typespec/protobuf", "protobuf");
    const old = await emitter.emitClean(
      source("protobuf", { fields: "@Protobuf.field(1) id: string;" }),
    );
    expect(textPayloadOf(old, "Event").schema).toContain("string id = 1");
    const next = await emitter.emit(
      source("protobuf", {
        fields: '@Protobuf.field(1) id: string; @Protobuf.field(2) note: string = "fallback";',
      }),
    );
    expect(next.doc).toBeNull();
    expect(next.diagnostics).toHaveLength(1);
    expect(next.diagnostics[0].message).toContain("explicit TypeSpec default");
  });

  it("E02 explicitly distinguishes successful proto3 reading from source-required own-field presence", async () => {
    const emitter = createArtifactEmitter("@typespec/protobuf", "protobuf");
    const old = textPayloadOf(
      await emitter.emitClean(source("protobuf", { fields: "@Protobuf.field(1) id: string;" })),
      "Event",
    ).schema;
    const next = textPayloadOf(
      await emitter.emitClean(
        source("protobuf", {
          fields: "@Protobuf.field(1) id: string; @Protobuf.field(2) note: string;",
        }),
      ),
      "Event",
    ).schema;
    const result = readProtobuf(old, next, "contract.Event", { id: "e" });
    expect(result).toMatchObject({ status: "decoded", readerVerification: null });
    if (result.status !== "decoded") throw new Error(result.reason);
    const requiredBySource = ["id", "note"];
    expect(requiredBySource.filter((field) => !result.ownFields.includes(field))).toEqual(["note"]);
  });

  it("E01 protobuf null is absent wire data, not a preserved nullable string", async () => {
    const doc = await createArtifactEmitter("@typespec/protobuf", "protobuf").emitClean(
      source("protobuf", {
        fields: "@Protobuf.field(1) note?: string;",
      }),
    );
    const text = textPayloadOf(doc, "Event").schema;
    expect(readProtobuf(text, text, "contract.Event", { note: null })).toMatchObject({
      status: "decoded",
      value: {},
      ownFields: [],
    });
  });

  it("E05 an old reader cannot forward an unknown protobuf tag through decode/re-encode", async () => {
    const emitter = createArtifactEmitter("@typespec/protobuf", "protobuf");
    const old = textPayloadOf(
      await emitter.emitClean(source("protobuf", { fields: "@Protobuf.field(1) id: string;" })),
      "Event",
    ).schema;
    const next = textPayloadOf(
      await emitter.emitClean(
        source("protobuf", {
          fields: "@Protobuf.field(1) id: string; @Protobuf.field(2) note?: string;",
        }),
      ),
      "Event",
    ).schema;
    const oldRead = readProtobuf(next, old, "contract.Event", { id: "e", note: "lost" });
    if (oldRead.status !== "decoded") throw new Error(oldRead.reason);
    expect(oldRead.value).toEqual({ id: "e" });
    const forwarded = readProtobuf(
      old,
      next,
      "contract.Event",
      oldRead.value as Record<string, unknown>,
    );
    expect(forwarded).toMatchObject({ status: "decoded", value: { id: "e" }, ownFields: ["id"] });
  });

  it("E05 reserved protobuf tags cannot be legally reused", async () => {
    const result = await createArtifactEmitter("@typespec/protobuf", "protobuf").emit(
      source("protobuf", {
        fields: "@Protobuf.field(2) note: string;",
        metadata: '@Protobuf.reserve(2, "note")',
      }),
    );
    expect(result.doc).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.severity).toBe("error");
      expect(diagnostic.code).toBe("tsp-asyncapi/protobuf-artifact-unavailable");
      expect(diagnostic.message).toMatch(/reserved/i);
      expect(targetText(diagnostic)).not.toBe("");
    }
  });

  it.each(["avro", "protobuf"] as const)(
    "F02 bounded seeded %s int32 values survive independent generated readers",
    async (dialect) => {
      const emitter = createArtifactEmitter(
        dialect === "avro" ? "tsp-avro" : "@typespec/protobuf",
        dialect,
      );
      const release = {
        fields: `${dialect === "protobuf" ? "@Protobuf.field(1)" : ""} count: int32;`,
      };
      const writer = payloadOf(await emitter.emitClean(source(dialect, release)), "Event").schema;
      const reader = payloadOf(await emitter.emitClean(source(dialect, release)), "Event").schema;
      fc.assert(
        fc.property(fc.integer({ min: -2147483648, max: 2147483647 }), (count) => {
          const result =
            dialect === "avro"
              ? readAvro(writer, reader, { count })
              : readProtobuf(writer as string, reader as string, "contract.Event", { count });
          expectOutcome(result, value({ count }), dialect === "protobuf");
        }),
        { seed: 31003, numRuns: 50 },
      );
    },
  );
});
