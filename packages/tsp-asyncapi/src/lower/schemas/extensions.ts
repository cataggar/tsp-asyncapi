import { type Model, type ModelProperty, type Program } from "@typespec/compiler";
import { getJsonSchemaExtensions, toPlainValue } from "tsp-asyncapi-core";
import type { SchemaObject } from "../../types/index.js";
import { SchemaDiagnostics } from "./diagnostics.js";
import { identityOf } from "../json-identity.js";

const LATER_KEYWORDS = new Set([
  "$defs",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentRequired",
  "dependentSchemas",
  "prefixItems",
  "minContains",
  "maxContains",
]);
const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const COUNTS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
]);
const BOUNDS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "definitions"]);
const SCHEMAS = new Set([
  "additionalProperties",
  "additionalItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);
const COMPOSITIONS = new Set(["allOf", "anyOf", "oneOf"]);
const ANNOTATIONS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "externalDocs",
  "$comment",
]);
const VALIDATION = new Set([
  "type",
  "enum",
  "const",
  "required",
  "items",
  "dependencies",
  "$ref",
  "format",
  "pattern",
  "multipleOf",
  "uniqueItems",
  ...COUNTS,
  ...BOUNDS,
  ...SCHEMA_MAPS,
  ...SCHEMAS,
  ...COMPOSITIONS,
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length
  );
}

function patternValid(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

function schemaValid(value: unknown): boolean {
  return (
    typeof value === "boolean" ||
    (object(value) && Object.entries(value).every(([key, child]) => keywordValid(key, child)))
  );
}

/** Bounded keyword-shape checks, not a schema-inclusion solver or a runtime validator. */
type KeywordValidator = (value: unknown) => boolean;
function entries(
  keys: Iterable<string>,
  validate: KeywordValidator,
): Record<string, KeywordValidator> {
  return Object.fromEntries([...keys].map((key) => [key, validate]));
}

const KEYWORD_VALIDATORS: Record<string, KeywordValidator> = {
  ...entries(COUNTS, (value) => typeof value === "number" && Number.isInteger(value) && value >= 0),
  ...entries(BOUNDS, (value) => typeof value === "number" && Number.isFinite(value)),
  ...entries(
    [
      "format",
      "$id",
      "$schema",
      "$ref",
      "title",
      "description",
      "$comment",
      "contentEncoding",
      "contentMediaType",
    ],
    (value) => typeof value === "string",
  ),
  ...entries(
    ["uniqueItems", "readOnly", "writeOnly", "deprecated"],
    (value) => typeof value === "boolean",
  ),
  ...entries(SCHEMA_MAPS, (value) => object(value) && Object.values(value).every(schemaValid)),
  ...entries(SCHEMAS, schemaValid),
  ...entries(
    COMPOSITIONS,
    (value) => Array.isArray(value) && value.length > 0 && value.every(schemaValid),
  ),
  type: (value) =>
    typeof value === "string"
      ? TYPES.has(value)
      : uniqueStrings(value) && value.length > 0 && value.every((type) => TYPES.has(type)),
  multipleOf: (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  required: uniqueStrings,
  enum: (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value.map(identityOf)).size === value.length,
  pattern: (value) => typeof value === "string" && patternValid(value),
  patternProperties: (value) =>
    object(value) &&
    Object.entries(value).every(([name, child]) => patternValid(name) && schemaValid(child)),
  items: (value) =>
    Array.isArray(value) ? value.length > 0 && value.every(schemaValid) : schemaValid(value),
  dependencies: (value) =>
    object(value) &&
    Object.values(value).every((child) =>
      Array.isArray(child) ? uniqueStrings(child) : schemaValid(child),
    ),
  examples: Array.isArray,
};

function keywordValid(key: string, value: unknown): boolean {
  return !Object.hasOwn(KEYWORD_VALIDATORS, key) || KEYWORD_VALIDATORS[key](value);
}

function laterKeywords(key: string, value: unknown, path = key): string[] {
  if (LATER_KEYWORDS.has(key)) return [path];
  if ((SCHEMA_MAPS.has(key) || key === "dependencies") && object(value)) {
    return Object.entries(value).flatMap(([name, child]) =>
      laterInSchema(child, `${path}/${name}`),
    );
  }
  if (SCHEMAS.has(key)) return laterInSchema(value, path);
  if (COMPOSITIONS.has(key) || key === "items") {
    return Array.isArray(value)
      ? value.flatMap((child, index) => laterInSchema(child, `${path}/${String(index)}`))
      : laterInSchema(value, path);
  }
  return [];
}

function laterInSchema(value: unknown, path: string): string[] {
  return object(value)
    ? Object.entries(value).flatMap(([key, child]) => laterKeywords(key, child, `${path}/${key}`))
    : [];
}

export function buildJsonSchemaExtensionFields(
  program: Program,
  target: Model | ModelProperty,
  generated: SchemaObject,
  diagnostics: SchemaDiagnostics,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const generatedFields: Record<string, unknown> = { ...generated };
  for (const { key, value } of getJsonSchemaExtensions(program, target)) {
    const plain = toPlainValue(program, value);
    if (!keywordValid(key, plain)) {
      diagnostics.reportOnce(
        {
          code: "invalid-schema-extension",
          target,
          format: { keyword: key, reason: "malformed keyword or nested schema" },
        },
        key,
      );
      continue;
    }
    for (const keyword of laterKeywords(key, plain)) {
      diagnostics.reportOnce(
        { code: "unsupported-schema-keyword", target, format: { keyword } },
        keyword,
      );
    }
    if (key === "$schema" && plain !== "http://json-schema.org/draft-07/schema#") {
      diagnostics.reportOnce(
        { code: "unsupported-schema-keyword", target, format: { keyword: "$schema" } },
        "$schema",
      );
    }
    const previous = Object.hasOwn(fields, key) ? fields[key] : generatedFields[key];
    const displacesSiblings =
      key === "$ref" &&
      Object.keys(generatedFields).some((name) => name !== "$ref" && VALIDATION.has(name));
    if (
      VALIDATION.has(key) &&
      !ANNOTATIONS.has(key) &&
      (displacesSiblings || (previous !== undefined && identityOf(previous) !== identityOf(plain)))
    ) {
      diagnostics.reportOnce(
        { code: "schema-extension-overrides-contract", target, format: { keyword: key } },
        key,
      );
    }
    fields[key] = plain;
  }
  return fields;
}
