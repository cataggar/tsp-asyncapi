import { describe, expect, it } from "vitest";
import { avroType, protobufType } from "../utils/binary-evolution.js";
import { payloadOf, textPayloadOf } from "../utils/artifacts.js";
import { recordFields } from "../utils/avro.js";
import { createMessageValidator } from "../utils/payload-validation.js";
import { readJson } from "../utils/evolution.js";
import {
  emitRetentionVersions,
  expectRetentionShape,
  retentionDocument,
  retentionVersions,
} from "../utils/retained-messages.js";

function binarySource(provider: "avro" | "protobuf", avroDefault = true): string {
  const tag = (id: number) =>
    provider === "protobuf" ? `@TypeSpec.Protobuf.field(${String(id)})` : "";
  return `
    @service @versioned(Versions)
    ${provider === "avro" ? '@Avro.avroNamespace("retention")' : '@TypeSpec.Protobuf.package({ name: "retention" })'}
    namespace App {
      enum Versions { v1: "1.0", v2: "2.0", v3: "3.0" }
      @message ${provider === "avro" ? "@Avro.avroRecord" : "@TypeSpec.Protobuf.message"}
      model Event {
        ${tag(1)} id: string;
        ${tag(2)} @added(Versions.v2) note?: string;
        ${tag(3)} @added(Versions.v3) generation: int32 ${provider === "avro" && avroDefault ? "= 0" : ""};
      }
      @channel("events") interface Events { @send op publish(event: Event): void; }
    }
  `;
}

const producedValues = [
  { id: "one" },
  { id: "two", note: "two" },
  { id: "three", note: "three", generation: 3 },
] as const;

async function avroSnapshots(withDefault = true) {
  const documents = await emitRetentionVersions(
    binarySource("avro", withDefault),
    undefined,
    "avro",
  );
  const schemas = retentionVersions.map((version, index) => {
    const payload = payloadOf(retentionDocument(documents, version), "Event");
    expect(payload.schemaFormat).toBe("application/vnd.apache.avro;version=1.9.0");
    expect(payload.schema).toMatchObject({ type: "record", name: "Event", namespace: "retention" });
    expect(recordFields(payload.schema)).toEqual([
      { name: "id", type: "string" },
      ...(index >= 1 ? [{ name: "note", type: ["null", "string"], default: null }] : []),
      ...(index >= 2
        ? [{ name: "generation", type: "int", ...(withDefault ? { default: 0 } : {}) }]
        : []),
    ]);
    return payload.schema;
  });
  return { writers: schemas.map(avroType), readers: schemas.map(avroType) };
}

describe("Version-generated binary retained messages", () => {
  it("Avro retains writer bytes but distinguishes materialized defaults and discarded fields", async () => {
    const { writers, readers } = await avroSnapshots();
    const queue = writers.map((writer, index) => {
      const value = producedValues[index];
      expect(writer.isValid(value)).toBe(true);
      const bytes = writer.toBuffer(value);
      expect(writer.fromBuffer(bytes)).toEqual(value);
      return { writer, bytes, original: Buffer.from(bytes) };
    });
    const expected = [
      [{ id: "one" }, { id: "one", note: null }, { id: "one", note: null, generation: 0 }],
      [{ id: "two" }, { id: "two", note: "two" }, { id: "two", note: "two", generation: 0 }],
      [{ id: "three" }, { id: "three", note: "three" }, producedValues[2]],
    ];
    for (const [producer, retained] of queue.entries()) {
      for (const [consumer, reader] of readers.entries()) {
        const resolver = reader.createResolver(retained.writer);
        const decoded: unknown = reader.fromBuffer(retained.bytes, resolver);
        expect(
          decoded,
          `Avro P${retentionVersions[producer]}->C${retentionVersions[consumer]}`,
        ).toEqual(expected[producer][consumer]);
        expect(retained.bytes.equals(retained.original)).toBe(true);
      }
    }
    // A v1 relay loses v3-only content; defaults on a later read are not its original values.
    const oldRead: unknown = readers[0].fromBuffer(
      queue[2].bytes,
      readers[0].createResolver(writers[2]),
    );
    const relayed = readers[0].toBuffer(oldRead);
    expect(relayed.equals(queue[2].bytes)).toBe(false);
    expect(readers[2].fromBuffer(relayed, readers[2].createResolver(readers[0]))).toEqual({
      id: "three",
      note: null,
      generation: 0,
    });
    expect(producedValues[2]).toEqual({ id: "three", note: "three", generation: 3 });
  });

  it("Avro refuses retained writers when the later required field has no reader default", async () => {
    const { writers, readers } = await avroSnapshots(false);
    const queue = writers.map((writer, index) => {
      const value = producedValues[index];
      expect(writer.isValid(value)).toBe(true);
      const bytes = writer.toBuffer(value);
      expect(writer.fromBuffer(bytes)).toEqual(value);
      return { writer, bytes, original: Buffer.from(bytes) };
    });
    expect(readers[1].fromBuffer(queue[0].bytes, readers[1].createResolver(writers[0]))).toEqual({
      id: "one",
      note: null,
    });
    for (const retained of queue.slice(0, 2)) {
      expect(() => readers[2].createResolver(retained.writer)).toThrow(/generation/);
      expect(retained.bytes.equals(retained.original)).toBe(true);
    }
    expect(readers[2].fromBuffer(queue[2].bytes, readers[2].createResolver(writers[2]))).toEqual(
      producedValues[2],
    );
    expect(readers[0].fromBuffer(queue[2].bytes, readers[0].createResolver(writers[2]))).toEqual({
      id: "three",
    });
  });

  it("Protobuf decode success does not supply a source-required field or preserve unknown tags", async () => {
    const source = binarySource("protobuf");
    const documents = await emitRetentionVersions(source, undefined, "protobuf");
    const native = await emitRetentionVersions(source, undefined, "protobuf", true);
    const schemas = retentionVersions.map((version, index) => {
      const payload = textPayloadOf(retentionDocument(documents, version), "Event");
      expect(payload.schemaFormat).toBe("application/vnd.google.protobuf;version=3");
      expect(payload.schema).toContain('syntax = "proto3";');
      const type = protobufType(payload.schema, "retention.Event");
      expect(
        type.fieldsArray.map((field) => ({ name: field.name, id: field.id, type: field.type })),
      ).toEqual([
        { name: "id", id: 1, type: "string" },
        ...(index >= 1 ? [{ name: "note", id: 2, type: "string" }] : []),
        ...(index >= 2 ? [{ name: "generation", id: 3, type: "int32" }] : []),
      ]);
      expectRetentionShape(retentionDocument(native, version), {
        payload: {
          properties: {
            id: { type: "string" },
            ...(index >= 1 ? { note: { type: "string" } } : {}),
            ...(index >= 2 ? { generation: { type: "integer", format: "int32" } } : {}),
          },
          required: index === 2 ? ["id", "generation"] : ["id"],
        },
      });
      return payload.schema;
    });
    const writers = schemas.map((schema) => protobufType(schema, "retention.Event"));
    const readers = schemas.map((schema) => protobufType(schema, "retention.Event"));
    const queue = writers.map((writer, index) => {
      const value = producedValues[index];
      const nativeWriter = retentionDocument(native, retentionVersions[index]);
      expect(readJson(nativeWriter, nativeWriter, { payload: value }).accepted).toBe(true);
      expect(writer.verify(value)).toBeNull();
      const bytes = Buffer.from(writer.encode(value).finish());
      expect(writer.toObject(writer.decode(bytes), { defaults: false })).toEqual(value);
      return { bytes, original: Buffer.from(bytes) };
    });
    const expected = [
      [producedValues[0], producedValues[0], producedValues[0]],
      [{ id: "two" }, producedValues[1], producedValues[1]],
      [{ id: "three" }, { id: "three", note: "three" }, producedValues[2]],
    ];
    for (const [producer, retained] of queue.entries()) {
      for (const [consumer, reader] of readers.entries()) {
        const decoded = reader.decode(retained.bytes);
        expect(reader.verify(decoded)).toBeNull();
        expect(
          reader.toObject(decoded, { defaults: false }),
          `Proto P${retentionVersions[producer]}->C${retentionVersions[consumer]}`,
        ).toEqual(expected[producer][consumer]);
        expect(retained.bytes.equals(retained.original)).toBe(true);
      }
    }
    const current = readers[2].decode(queue[0].bytes);
    expect(Object.hasOwn(current, "generation")).toBe(false);
    const sourceConsumer = createMessageValidator(retentionDocument(native, "3.0"), "Event");
    const semantic = sourceConsumer.validate({
      payload: readers[2].toObject(current, { defaults: false }),
    });
    expect(semantic.accepted).toBe(false);
    expect(semantic.errors).toEqual([expect.stringContaining("generation")]);

    const oldRead = readers[0].decode(queue[2].bytes);
    const relayed = Buffer.from(readers[0].encode(oldRead).finish());
    expect(relayed.equals(queue[2].bytes)).toBe(false);
    const afterRelay = readers[2].toObject(readers[2].decode(relayed), { defaults: false });
    expect(afterRelay).toEqual({ id: "three" });
    expect(sourceConsumer.validate({ payload: afterRelay }).accepted).toBe(false);
  });
});
