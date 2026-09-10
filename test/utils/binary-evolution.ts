import avro from "avsc";
import { Enum, parse, Root, Type, type Field } from "protobufjs";

export type BinaryReadResult =
  | {
      readonly status: "decoded";
      readonly value: unknown;
      readonly ownFields: readonly string[];
      readonly bytes: Uint8Array;
      /** The library's wire-value check; proto3 enums are open. */
      readonly readerVerification?: string | null;
      /** A separate application policy: every enum number must be reader-known. */
      readonly unknownEnums?: readonly string[];
    }
  | {
      readonly status: "rejected";
      readonly phase: "writer" | "resolver" | "reader";
      readonly reason: string;
    };

/** No custom logical adapters: logical annotations remain separate evidence. */
export function avroType(schema: unknown): avro.Type {
  return avro.Type.forSchema(schema as avro.Schema, { wrapUnions: false });
}

/** Independently parse each text; never infer a root from declaration order. */
export function protobufType(text: string, rootName: string): Type {
  const root = parse(text, new Root(), { keepCase: true }).root;
  root.resolveAll();
  return root.lookupType(rootName);
}

function rejection(phase: "writer" | "resolver" | "reader", error: unknown): BinaryReadResult {
  if (!(error instanceof Error)) throw error;
  return { status: "rejected", phase, reason: error.message };
}

function ownFields(value: unknown): string[] {
  return value !== null && typeof value === "object"
    ? Object.keys(value).sort((a, b) => a.localeCompare(b))
    : [];
}

function fieldValues(field: Field, value: unknown): unknown[] {
  if (field.repeated) return value as unknown[];
  if (field.map) return Object.values(value as Record<string, unknown>);
  return [value];
}

function unknownEnums(type: Type, value: object, prefix = ""): string[] {
  const unknown: string[] = [];
  for (const field of type.fieldsArray) {
    const fieldValue: unknown = (value as Record<string, unknown>)[field.name];
    if (fieldValue === undefined || fieldValue === null) continue;
    const name = `${prefix}${field.name}`;
    for (const item of fieldValues(field, fieldValue)) {
      if (
        field.resolvedType instanceof Enum &&
        !Object.hasOwn(field.resolvedType.valuesById, String(item))
      ) {
        unknown.push(name);
      } else if (field.resolvedType instanceof Type && item !== null && typeof item === "object") {
        unknown.push(...unknownEnums(field.resolvedType, item, `${name}.`));
      }
    }
  }
  return unknown;
}

/**
 * Reader resolution is directional. avsc permits undeclared writer properties,
 * skips unknown writer fields on read, and materializes declared reader defaults.
 */
export function readAvro(
  writerSchema: unknown,
  readerSchema: unknown,
  value: unknown,
): BinaryReadResult {
  const writer = avroType(writerSchema);
  const reader = avroType(readerSchema);
  if (!writer.isValid(value, { noUndeclaredFields: false })) {
    return { status: "rejected", phase: "writer", reason: "Invalid Avro writer value." };
  }
  let bytes: Buffer;
  try {
    bytes = writer.toBuffer(value);
  } catch (error) {
    return rejection("writer", error);
  }
  let resolver: avro.Resolver;
  try {
    resolver = reader.createResolver(writer);
  } catch (error) {
    return rejection("resolver", error);
  }
  try {
    const decoded: unknown = reader.fromBuffer(bytes, resolver);
    return { status: "decoded", value: decoded, ownFields: ownFields(decoded), bytes };
  } catch (error) {
    return rejection("reader", error);
  }
}

/**
 * verify does not enforce TypeSpec requiredness or reject undeclared fields.
 * Numeric enums, missing singular fields, and lost tags need explicit assertions.
 */
export function readProtobuf(
  writerText: string,
  readerText: string,
  rootName: string,
  value: Record<string, unknown>,
): BinaryReadResult {
  const writer = protobufType(writerText, rootName);
  const reader = protobufType(readerText, rootName);
  const invalid = writer.verify(value);
  if (invalid !== null) return { status: "rejected", phase: "writer", reason: invalid };
  let bytes: Uint8Array;
  try {
    bytes = writer.encode(value).finish();
  } catch (error) {
    return rejection("writer", error);
  }
  try {
    const decoded = reader.decode(bytes);
    return {
      status: "decoded",
      value: reader.toObject(decoded, {
        longs: String,
        enums: Number,
        bytes: Array,
        defaults: false,
        arrays: false,
        objects: false,
      }),
      ownFields: ownFields(decoded),
      bytes,
      readerVerification: reader.verify(decoded),
      unknownEnums: unknownEnums(reader, decoded),
    };
  } catch (error) {
    return rejection("reader", error);
  }
}
