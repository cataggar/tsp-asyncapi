import type { AnySchema } from "ajv";

const MAP_SCHEMAS = new Set(["definitions", "properties", "patternProperties"]);
const ARRAY_SCHEMAS = new Set(["allOf", "anyOf", "oneOf"]);
const SINGLE_SCHEMAS = new Set([
  "additionalProperties",
  "additionalItems",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
]);
const ANNOTATIONS = new Set([
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "contentEncoding",
  "contentMediaType",
  "deprecated",
  "discriminator",
  "externalDocs",
]);
const VALUES = new Set([
  "$id",
  "$schema",
  "$ref",
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "format",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxProperties",
  "minProperties",
  "required",
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaMap(value: unknown, dependencies = false): Record<string, unknown> {
  if (!object(value)) throw new Error("Expected a map of draft-07 schemas.");
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      dependencies && Array.isArray(child) ? structuredClone(child) : compilationSchema(child),
    ]),
  );
}

function schemaArray(value: unknown): AnySchema[] {
  if (!Array.isArray(value)) throw new Error("Expected an array of draft-07 schemas.");
  return value.map(compilationSchema);
}

/**
 * Ajv indexes $id inside unknown annotation objects. Strip those only at schema
 * positions; identifiers in real schemas and literal enum/const data stay intact.
 * This is deliberately draft-07, not the OpenAPI 2020-12 compilation vocabulary.
 */
export function compilationSchema(value: unknown): AnySchema {
  return typeof value === "boolean" ? value : compilationObject(value);
}

function compilationObject(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error("Expected an object or boolean JSON schema.");
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      if (ANNOTATIONS.has(key) || key.startsWith("x-")) return [];
      // Ajv can check a lone type before its ignoreKeywordsWithRef branch runs.
      if (key === "type" && typeof value.$ref === "string") return [];
      return [[key, compilationKeyword(key, child)]];
    }),
  );
}

function compilationKeyword(key: string, value: unknown): unknown {
  if (VALUES.has(key)) return structuredClone(value);
  if (MAP_SCHEMAS.has(key)) return schemaMap(value);
  if (ARRAY_SCHEMAS.has(key)) return schemaArray(value);
  if (SINGLE_SCHEMAS.has(key)) return compilationSchema(value);
  if (key === "dependencies") return schemaMap(value, true);
  if (key === "items") return Array.isArray(value) ? schemaArray(value) : compilationSchema(value);
  throw new Error(`Unsupported draft-07 schema keyword: ${key}`);
}
