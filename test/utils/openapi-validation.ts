import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import { readFileSync } from "node:fs";

type ObjectValue = Record<string, unknown>;
type Schema = ObjectValue | boolean;
interface Reference {
  value: string;
  path: string;
}

const RESOURCES = new URL("../fixtures/openapi/3.1/", import.meta.url);
const DOCUMENT_ID = "https://openapi.example.invalid/document";
const OAS_DIALECT = "https://spec.openapis.org/oas/3.1/dialect/base";
const DIALECTS = new Set([OAS_DIALECT, "https://spec.openapis.org/oas/3.1/dialect/2024-11-10"]);
const MAP_SCHEMAS = ["$defs", "properties", "patternProperties", "dependentSchemas"];
const ARRAY_SCHEMAS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SINGLE_SCHEMAS = [
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "items",
  "unevaluatedItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
];

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resource(name: string): ObjectValue {
  return JSON.parse(readFileSync(new URL(`${name}.json`, RESOURCES), "utf8")) as ObjectValue;
}

function fragment(path: string): string {
  return `#${path.split("/").map(encodeURIComponent).join("/")}`;
}

function token(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Resolve only self-contained URI-fragment JSON Pointers, without following links. */
function resolve(document: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported non-local reference: ${ref}`);
  const pointer = decodeURIComponent(ref.slice(2));
  let node = document;
  for (const part of pointer.split("/")) {
    if (/~(?![01])/.test(part)) throw new Error(`Invalid JSON Pointer escape in ${ref}`);
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
      throw new Error(`Unresolved reference: ${ref}`);
    }
    node = (node as ObjectValue)[key];
  }
  return node;
}

// RFC 9110 sections 5.6.2, 5.6.4 and 12.5.1: tokens, quoted strings, media ranges.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const QUOTED = '"(?:[\\t !#-\\[\\]-~\\x80-\\xff]|\\\\[\\t -~\\x80-\\xff])*"';
const MEDIA_RANGE = new RegExp(
  `^(${TOKEN})/(${TOKEN})(?:[\\t ]*;[\\t ]*${TOKEN}=(?:${TOKEN}|${QUOTED}))*[\\t ]*$`,
);

function createAjv(): Ajv2020 {
  const ajv = addFormatsModule.default(
    new Ajv2020({
      strict: false,
      allErrors: true,
      validateFormats: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    }),
  );
  ajv.addFormat("media-range", (value: string) => {
    const match = MEDIA_RANGE.exec(value);
    return match !== null && (match[1] !== "*" || match[2] === "*");
  });
  for (const name of ["meta", "meta-2024-11-10", "dialect", "dialect-2024-11-10"]) {
    ajv.addMetaSchema(resource(name));
  }
  return ajv;
}

/**
 * Ajv 8.20 resolves the official nested #meta dynamic anchor to the document
 * root, rejecting even {type:"string"}. With one fixed supported dialect,
 * direct references to that schema slot have the intended meaning.
 * The vendored original is never changed.
 */
function adaptStructure(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(adaptStructure);
  } else if (object(node)) {
    if (node.$dynamicRef === "#meta") {
      delete node.$dynamicRef;
      node.$ref = "#/$defs/schema";
    }
    if (object(node.properties) && object(node.properties.$ref)) {
      node.properties.$ref.collectOpenAPIReference = true;
    }
    Object.values(node).forEach(adaptStructure);
  }
}

function report(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"}: ${error.keyword} ${error.message ?? ""}`)
    .join("\n");
}

function schemaChildren(schema: ObjectValue): [string, unknown][] {
  const children: [string, unknown][] = [];
  for (const key of MAP_SCHEMAS) {
    const entries = schema[key];
    if (object(entries)) {
      for (const [name, value] of Object.entries(entries)) {
        children.push([`${key}/${token(name)}`, value]);
      }
    }
  }
  for (const key of ARRAY_SCHEMAS) {
    const entries = schema[key];
    if (Array.isArray(entries)) {
      entries.forEach((value: unknown, index) => children.push([`${key}/${String(index)}`, value]));
    }
  }
  for (const key of SINGLE_SCHEMAS) {
    if (key in schema) children.push([key, schema[key]]);
  }
  return children;
}

function inspectSchema(
  schema: Schema,
  path: string,
  ajv: Ajv2020,
  schemas: Set<string>,
  references: Reference[],
): void {
  schemas.add(fragment(path));
  if (typeof schema === "boolean") return;
  for (const key of ["$id", "$anchor", "$dynamicAnchor", "$dynamicRef"]) {
    if (key in schema) throw new Error(`Unsupported schema resource keyword ${key} at ${path}`);
  }
  if (
    schema.$schema !== undefined &&
    (typeof schema.$schema !== "string" || !DIALECTS.has(schema.$schema))
  ) {
    throw new Error(`Unsupported schema dialect ${JSON.stringify(schema.$schema)} at ${path}`);
  }
  if (typeof schema.format === "string" && !Object.hasOwn(ajv.formats, schema.format)) {
    throw new Error(`Unsupported schema format ${schema.format} at ${path}`);
  }
  if (typeof schema.$ref === "string") {
    references.push({ value: schema.$ref, path: `${path}/$ref` });
  }
  for (const [suffix, child] of schemaChildren(schema)) {
    if (object(child) || typeof child === "boolean") {
      inspectSchema(child, `${path}/${suffix}`, ajv, schemas, references);
    }
  }
}

function prepare(document: unknown): { ajv: Ajv2020; schemas: Set<string> } {
  const ajv = createAjv();
  const roots = new Map<string, Schema>();
  const references: Reference[] = [];
  const schemaReferences: Reference[] = [];
  const securityNames = new Set<string>();
  const schemas = new Set<string>();
  if (!object(document)) throw new Error("Expected an OpenAPI document object.");
  const dialect = document.jsonSchemaDialect ?? OAS_DIALECT;
  if (typeof dialect !== "string" || !DIALECTS.has(dialect)) {
    throw new Error(`Unsupported document schema dialect: ${JSON.stringify(dialect)}`);
  }
  ajv.addKeyword({
    keyword: "collectOpenAPISchema",
    schemaType: "boolean",
    errors: false,
    validate: (
      _enabled: boolean,
      schema: Schema,
      _parent: unknown,
      context?: { instancePath: string },
    ) => {
      roots.set(context?.instancePath ?? "", schema);
      return true;
    },
  });
  ajv.addKeyword({
    keyword: "collectOpenAPISecurity",
    schemaType: "boolean",
    errors: false,
    validate: (_enabled: boolean, name: string) => {
      securityNames.add(name);
      return true;
    },
  });
  ajv.addKeyword({
    keyword: "collectOpenAPIReference",
    schemaType: "boolean",
    errors: false,
    validate: (
      _enabled: boolean,
      value: string,
      _parent: unknown,
      context?: { instancePath: string },
    ) => {
      references.push({ value, path: context?.instancePath ?? "" });
      return true;
    },
  });
  const structure = resource("schema");
  adaptStructure(structure);
  const defs = structure.$defs as ObjectValue;
  defs.schema = { $ref: OAS_DIALECT, collectOpenAPISchema: true };
  (defs["security-requirement"] as ObjectValue).propertyNames = {
    collectOpenAPISecurity: true,
  };
  const validate = ajv.compile(structure);
  if (!validate(document))
    throw new Error(`OpenAPI structure/schema validation failed:\n${report(validate.errors)}`);
  for (const [path, schema] of roots) inspectSchema(schema, path, ajv, schemas, schemaReferences);
  for (const { value, path } of [...references, ...schemaReferences]) {
    try {
      resolve(document, value);
    } catch (error) {
      throw new Error(`${path}: ${String(error)}`, { cause: error });
    }
  }
  for (const { value, path } of schemaReferences) {
    const normalized = fragment(decodeURIComponent(value.slice(1)));
    if (!schemas.has(normalized))
      throw new Error(`Reference at ${path} does not target a schema: ${value}`);
  }
  const security = object(document.components) ? document.components.securitySchemes : undefined;
  for (const name of securityNames) {
    if (!object(security) || !Object.hasOwn(security, name)) {
      throw new Error(`Unresolved security scheme: ${name}`);
    }
  }
  ajv.addSchema(document, DOCUMENT_ID);
  for (const ref of schemas) {
    // This checks compilability (including invalid regexes), not instance acceptance.
    ajv.getSchema(`${DOCUMENT_ID}${ref}`);
  }
  return { ajv, schemas };
}

/**
 * Offline structure, Schema Object and local-reference checks for OpenAPI 3.1.
 * Examples/defaults are data, not references or proof of instance acceptance.
 * External resources and schema-local identifiers/anchors are explicitly unsupported.
 */
export function validateOpenAPI31Document(document: unknown): string | null {
  try {
    prepare(document);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Compile a Schema Object pointer separately for non-mutating instance checks. */
export function compileOpenAPI31Schema(document: unknown, ref: string): ValidateFunction {
  const { ajv, schemas } = prepare(document);
  const normalized = fragment(decodeURIComponent(ref.slice(1)));
  if (!ref.startsWith("#/") || !schemas.has(normalized)) {
    throw new Error(`Expected a document-local Schema Object pointer, got ${ref}.`);
  }
  const validate = ajv.getSchema(`${DOCUMENT_ID}${normalized}`);
  if (validate === undefined) throw new Error(`No compiled schema for ${ref}.`);
  return validate;
}
