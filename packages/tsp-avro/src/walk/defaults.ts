import {
  isAvroUnion,
  type AvroDefault,
  type AvroEnum,
  type AvroFixed,
  type AvroRecord,
  type AvroSchema,
} from "../types.js";

type NamedSchema = AvroRecord | AvroEnum | AvroFixed;

function object(value: AvroDefault): value is Readonly<Record<string, AvroDefault>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check defaults only after the complete named-schema graph has been built. */
export class AvroDefaultValidator {
  private readonly named = new Map<string, NamedSchema>();
  private readonly active = new Map<AvroSchema, Set<AvroDefault>>();

  public constructor(root: AvroSchema) {
    this.collect(root);
  }

  private collect(schema: AvroSchema): void {
    if (typeof schema === "string") return;
    if (isAvroUnion(schema)) {
      schema.forEach((branch) => {
        this.collect(branch);
      });
    } else if (schema.type === "array") {
      this.collect(schema.items);
    } else if (schema.type === "map") {
      this.collect(schema.values);
    } else if (schema.type === "record" || schema.type === "enum" || schema.type === "fixed") {
      const name = schema.namespace ? `${schema.namespace}.${schema.name}` : schema.name;
      this.named.set(name, schema);
      if (schema.type === "record") {
        schema.fields.forEach((field) => {
          this.collect(field.type);
        });
      }
    }
  }

  public validate(schema: AvroSchema, value: AvroDefault, path: string): string | undefined {
    let values = this.active.get(schema);
    if (values?.has(value)) return `${path} requires an infinitely recursive default.`;
    if (values === undefined) {
      values = new Set();
      this.active.set(schema, values);
    }
    values.add(value);
    const reason = this.check(schema, value, path);
    values.delete(value);
    return reason;
  }

  private check(schema: AvroSchema, value: AvroDefault, path: string): string | undefined {
    if (isAvroUnion(schema)) {
      const reason = this.validate(schema[0], value, path);
      return reason === undefined
        ? undefined
        : `${path} must match its first union branch: ${reason}`;
    }
    if (typeof schema === "string") {
      const named = this.named.get(schema);
      return named === undefined
        ? primitiveDefault(schema, value, path)
        : this.validate(named, value, path);
    }
    switch (schema.type) {
      case "record":
        return this.record(schema, value, path);
      case "array":
        return this.array(schema.items, value, path);
      case "map":
        return this.map(schema.values, value, path);
      case "enum":
        return typeof value === "string" && schema.symbols.includes(value)
          ? undefined
          : `${path} must name an enum symbol.`;
      case "fixed":
        return bytesDefault(value) && value.length === schema.size
          ? undefined
          : `${path} must contain ${String(schema.size)} fixed bytes.`;
      default:
        return primitiveDefault(schema.type, value, path);
    }
  }

  private array(schema: AvroSchema, value: AvroDefault, path: string): string | undefined {
    return Array.isArray(value)
      ? this.entries(schema, value.entries(), path)
      : `${path} must be an array.`;
  }

  private map(schema: AvroSchema, value: AvroDefault, path: string): string | undefined {
    return object(value)
      ? this.entries(schema, Object.entries(value), path)
      : `${path} must be a map.`;
  }

  private record(schema: AvroRecord, value: AvroDefault, path: string): string | undefined {
    if (!object(value)) return `${path} must be a record.`;
    for (const field of schema.fields) {
      const child = Object.hasOwn(value, field.name) ? value[field.name] : field.default;
      if (child === undefined) return `${path}.${field.name} has no value or field default.`;
      const reason = this.validate(field.type, child, `${path}.${field.name}`);
      if (reason !== undefined) return reason;
    }
    return undefined;
  }

  private entries(
    schema: AvroSchema,
    entries: Iterable<readonly [string | number, AvroDefault]>,
    path: string,
  ): string | undefined {
    for (const [key, value] of entries) {
      const reason = this.validate(schema, value, `${path}[${JSON.stringify(key)}]`);
      if (reason !== undefined) return reason;
    }
    return undefined;
  }
}

function bytesDefault(value: AvroDefault): value is string {
  if (typeof value !== "string") return false;
  for (const character of value) {
    if (character.charCodeAt(0) > 255) return false;
  }
  return true;
}

function primitiveDefault(type: string, value: AvroDefault, path: string): string | undefined {
  let valid: boolean;
  switch (type) {
    case "null":
      valid = value === null;
      break;
    case "string":
      valid = typeof value === "string";
      break;
    case "bytes":
      valid = bytesDefault(value);
      break;
    case "boolean":
      valid = typeof value === "boolean";
      break;
    case "int":
      valid =
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= -2147483648 &&
        value <= 2147483647;
      break;
    case "long":
      valid =
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= -(2 ** 63) &&
        value < 2 ** 63;
      break;
    case "float":
    case "double":
      valid = typeof value === "number" && Number.isFinite(value);
      break;
    default:
      return `${path} references an unknown Avro type '${type}'.`;
  }
  return valid ? undefined : `${path} must be an Avro ${type}.`;
}
