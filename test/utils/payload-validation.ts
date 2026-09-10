import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { AsyncAPIDocument } from "#emitter/types/index.js";
import { resolveRef } from "./json-pointer.js";
import { avroType, protobufType } from "./binary-evolution.js";
import { compilationSchema } from "./draft07-schema.js";

export interface ConsumerProfile {
  readonly formats?: "assert" | "annotation";
  /** Explicit limitations, never silently inferred from unknown format names. */
  readonly annotationFormats?: readonly string[];
  /** JSON Pointers to objects, with consumer-known fields; independent of allOf. */
  readonly knownFields?: Readonly<Record<string, readonly string[]>>;
  readonly protobufRoot?: string;
}

export interface Acceptance {
  readonly accepted: boolean;
  readonly errors: readonly string[];
}

export interface PayloadValidator {
  readonly lane: "draft-07" | "avro-1.9" | "proto2" | "proto3";
  readonly limitations: readonly string[];
  readonly validate: (value: unknown) => Acceptance;
}

const JSON_FORMATS = new Set([
  "application/vnd.aai.asyncapi;version=3.1.0",
  "application/vnd.aai.asyncapi+json;version=3.1.0",
  "application/vnd.aai.asyncapi+yaml;version=3.1.0",
  "application/schema+json;version=draft-07",
  "application/schema+yaml;version=draft-07",
]);
const AVRO_FORMATS = new Set([
  "application/vnd.apache.avro;version=1.9.0",
  "application/vnd.apache.avro+json;version=1.9.0",
  "application/vnd.apache.avro+yaml;version=1.9.0",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Follow only outer reference objects; dialect-internal references stay with the codec. */
export function emittedSchema(doc: AsyncAPIDocument, value: unknown): unknown {
  const seen = new Set<string>();
  while (
    record(value) &&
    typeof value.$ref === "string" &&
    value.$ref.startsWith("#/components/")
  ) {
    const ref = value.$ref;
    if (seen.has(ref)) throw new Error(`Circular outer reference: ${ref}`);
    seen.add(ref);
    value = resolveRef(doc, ref);
    if (value === undefined) throw new Error(`Missing schema reference: ${ref}`);
  }
  return value;
}

function closedErrors(value: unknown, fields: ConsumerProfile["knownFields"]): string[] {
  const errors: string[] = [];
  for (const [path, names] of Object.entries(fields ?? {})) {
    const object = path === "" ? value : resolveRef(value, `#${path}`);
    if (!record(object)) continue;
    for (const name of Object.keys(object)) {
      if (!names.includes(name)) errors.push(`${path}/${name}: consumer does not know this field`);
    }
  }
  return errors;
}

function jsonErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath}: ${error.keyword} ${error.message ?? ""}`,
  );
}

function jsonValidator(
  doc: AsyncAPIDocument,
  value: unknown,
  profile: ConsumerProfile,
  authored: boolean,
): PayloadValidator {
  const ajv = addFormatsModule.default(
    new Ajv({
      strictSchema: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      allErrors: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
      // Ajv otherwise applies validation siblings, contrary to draft-07 $ref.
      ignoreKeywordsWithRef: true,
      validateFormats: profile.formats !== "annotation",
    }),
  );
  for (const [name, minimum, maximum] of [
    ["int8", -128, 127],
    ["int16", -32768, 32767],
    ["int32", -2147483648, 2147483647],
    ["uint8", 0, 255],
    ["uint16", 0, 65535],
    ["uint32", 0, 4294967295],
    ["int64", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ["uint64", 0, Number.MAX_SAFE_INTEGER],
  ] as const) {
    ajv.addFormat(name, {
      type: "number",
      validate: (number: number) =>
        Number.isSafeInteger(number) && number >= minimum && number <= maximum,
    });
  }
  ajv.addFormat("unixtime", { type: "number", validate: Number.isSafeInteger });
  ajv.addFormat("base64url", {
    type: "string",
    validate: (value: string) =>
      /^[A-Za-z0-9_-]*={0,2}$/.test(value) &&
      (value.includes("=") ? value.length % 4 === 0 : value.length % 4 !== 1),
  });
  for (const name of profile.annotationFormats ?? []) ajv.addFormat(name, true);

  // One registry per document, retaining graph edges rather than recursively inlining.
  const schema = compilationSchema(value);
  if (!authored) {
    for (const [name, component] of Object.entries(doc.components?.schemas ?? {})) {
      if ("schemaFormat" in component) continue;
      const escaped = name.replaceAll("~", "~0").replaceAll("/", "~1");
      const registered = component === value ? schema : compilationSchema(component);
      ajv.addSchema(registered, `#/components/schemas/${escaped}`);
    }
  }
  const validate: ValidateFunction = ajv.compile(schema);
  return {
    lane: "draft-07",
    limitations: [
      "Numeric witnesses are restricted to JavaScript safe precision.",
      ...(profile.formats === "annotation" ? ["Formats are annotations, not assertions."] : []),
      ...(profile.annotationFormats ?? []).map((format) => `Format ${format} is annotation-only.`),
    ],
    validate(value) {
      const accepted = validate(value);
      const errors = [...jsonErrors(validate.errors), ...closedErrors(value, profile.knownFields)];
      return { accepted: accepted && errors.length === 0, errors };
    },
  };
}

export function createPayloadValidator(
  doc: AsyncAPIDocument,
  value: unknown,
  profile: ConsumerProfile = {},
): PayloadValidator {
  const selected = emittedSchema(doc, value);
  if (!record(selected) || !("schemaFormat" in selected)) {
    return jsonValidator(doc, selected, profile, false);
  }
  const format = selected.schemaFormat;
  if (typeof format !== "string") throw new Error("schemaFormat must be a string.");
  if (JSON_FORMATS.has(format)) return jsonValidator(doc, selected.schema, profile, true);
  if (AVRO_FORMATS.has(format)) {
    const type = avroType(selected.schema);
    return {
      lane: "avro-1.9",
      limitations: ["Logical annotations and application requiredness need separate assertions."],
      validate(value) {
        const accepted = type.isValid(value, { noUndeclaredFields: false });
        if (accepted) type.fromBuffer(type.toBuffer(value));
        return { accepted, errors: accepted ? [] : ["Invalid Avro writer value."] };
      },
    };
  }
  if (/^application\/vnd\.google\.protobuf;version=[23]$/.test(format)) {
    if (typeof selected.schema !== "string") throw new Error("Protobuf schema must be text.");
    if (!profile.protobufRoot) throw new Error("An explicit Protobuf root is required.");
    const type = protobufType(selected.schema, profile.protobufRoot);
    return {
      lane: format.endsWith("3") ? "proto3" : "proto2",
      limitations: [
        "Binary presence, defaults, unknown fields and enums need separate assertions.",
      ],
      validate(value) {
        if (!record(value)) return { accepted: false, errors: ["Expected a message object."] };
        const reason = type.verify(value);
        if (reason !== null) return { accepted: false, errors: [reason] };
        type.decode(type.encode(value).finish());
        return { accepted: true, errors: [] };
      },
    };
  }
  throw new Error(`No payload-validation lane for pass-through schemaFormat: ${format}`);
}

export function createMessageValidator(
  doc: AsyncAPIDocument,
  name: string,
  profile: ConsumerProfile = {},
  headerProfile: ConsumerProfile = {},
) {
  const message = emittedSchema(doc, doc.components?.messages?.[name]);
  if (!record(message)) throw new Error(`Missing emitted message: ${name}`);
  const payload = createPayloadValidator(doc, message.payload, profile);
  const headers =
    message.headers !== undefined
      ? createPayloadValidator(doc, message.headers, headerProfile)
      : undeclaredHeaders(doc, headerProfile);
  return {
    payload,
    headers,
    validate(value: { payload: unknown; headers?: unknown }): Acceptance {
      const body = payload.validate(value.payload);
      const head = headers?.validate(value.headers === undefined ? {} : value.headers);
      return {
        accepted: body.accepted && (head?.accepted ?? true),
        errors: [
          ...body.errors.map((error) => `payload${error}`),
          ...(head?.errors ?? []).map((error) => `headers${error}`),
        ],
      };
    },
  };
}

function undeclaredHeaders(
  doc: AsyncAPIDocument,
  profile: ConsumerProfile,
): PayloadValidator | undefined {
  if (profile.knownFields === undefined) return undefined;
  return createPayloadValidator(doc, { type: "object" }, profile);
}
