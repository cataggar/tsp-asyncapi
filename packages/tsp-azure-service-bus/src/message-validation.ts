import {
  getEncode,
  getLifecycleVisibilityEnum,
  getMaxValue,
  getMinValue,
  getVisibilityForClass,
  isStringType,
  navigateType,
  resolveEncodedName,
  walkPropertiesInherited,
  type Model,
  type ModelProperty,
  type Program,
  type Scalar,
  type Type,
} from "@typespec/compiler";
import {
  getContentType,
  getCorrelationId,
  getHeadersModel,
  getJsonSchemaExtensions,
  getRawHeaders,
  getRawPayload,
  isHeader,
} from "tsp-asyncapi-core";
import { problem } from "./state.js";
import { nativeLengthAllows } from "./profile.js";
import type { MessageProfile, NativeString } from "./types.js";

function scalarChain(type: Scalar): Scalar[] {
  const chain: Scalar[] = [];
  for (let scalar: Scalar | undefined = type; scalar; scalar = scalar.baseScalar)
    chain.push(scalar);
  return chain;
}

function numericKind(type: Scalar): "integer" | "number" | undefined {
  const names = scalarChain(type)
    .filter((scalar) => scalar.namespace?.name === "TypeSpec")
    .map((scalar) => scalar.name);
  if (names.some((name) => ["decimal", "decimal128"].includes(name))) return undefined;
  if (names.some((name) => ["integer", "safeint"].includes(name))) return "integer";
  if (names.some((name) => ["numeric", "float", "float32", "float64"].includes(name)))
    return "number";
  return undefined;
}

function portableProperty(program: Program, property: ModelProperty): boolean {
  if (getJsonSchemaExtensions(program, property).length > 0 || getEncode(program, property))
    return false;
  const type = property.type;
  if (type.kind === "String" || type.kind === "Boolean") return true;
  if (type.kind === "Number") return type.numericValue.asNumber() !== null;
  if (type.kind === "EnumMember") return type.value === undefined || typeof type.value === "string";
  if (type.kind === "Enum")
    return [...type.members.values()].every(
      (member) => member.value === undefined || typeof member.value === "string",
    );
  if (type.kind === "Union")
    return [...type.variants.values()].every((variant) => variant.type.kind === "String");
  if (type.kind !== "Scalar") return false;
  const chain = scalarChain(type);
  if (chain.some((scalar) => getEncode(program, scalar) !== undefined)) return false;
  if (
    isStringType(program, type) ||
    chain.some((scalar) => scalar.name === "boolean" && scalar.namespace?.name === "TypeSpec")
  )
    return true;
  const kind = numericKind(type);
  if (kind === "number") return true;
  if (kind !== "integer") return false;
  const min =
    getMinValue(program, property) ??
    chain.map((scalar) => getMinValue(program, scalar)).find((value) => value !== undefined);
  const max =
    getMaxValue(program, property) ??
    chain.map((scalar) => getMaxValue(program, scalar)).find((value) => value !== undefined);
  return (
    min !== undefined &&
    max !== undefined &&
    Number.isSafeInteger(min) &&
    Number.isSafeInteger(max) &&
    min <= max
  );
}

function validateHeaders(program: Program, message: Model): void {
  const headers = getHeadersModel(program, message);
  const lifted = [...walkPropertiesInherited(message)].filter((property) =>
    isHeader(program, property),
  );
  if (lifted.length > 0) {
    problem(
      program,
      message,
      "application-properties",
      "Lifted @header schemas are open in the current core. Use @headers with an explicitly closed flat model.",
    );
  }
  if (headers === undefined) return;
  const extensions = getJsonSchemaExtensions(program, headers);
  if (
    headers.baseModel ||
    headers.indexer ||
    !extensions.some(({ key, value }) => key === "additionalProperties" && value === false) ||
    extensions.some(({ key, value }) => key !== "additionalProperties" || value !== false)
  ) {
    problem(
      program,
      message,
      "application-properties",
      `Headers '${headers.name}' must be a flat, non-inherited object with only additionalProperties:false as a schema override.`,
    );
  }
  const wireNames = new Set<string>();
  for (const property of walkPropertiesInherited(headers)) {
    if (!visible(program, property)) continue;
    if (!portableProperty(program, property)) {
      problem(
        program,
        property,
        "application-properties",
        `Application property '${property.name}' must be a string, boolean, bounded safe integer or finite number without raw schema/encoding overrides.`,
      );
    }
    const name = resolveEncodedName(program, property, "application/json");
    if (wireNames.has(name))
      problem(
        program,
        property,
        "application-properties",
        `Duplicate application-property wire name '${name}'.`,
      );
    wireNames.add(name);
  }
}

function scalarValue(program: Program, type: Type, inProgress = new Set<Type>()): boolean {
  if (["String", "Number", "Boolean", "Enum", "EnumMember"].includes(type.kind)) return true;
  if (type.kind === "Union") {
    if (inProgress.has(type)) return false;
    inProgress.add(type);
    const scalar = [...type.variants.values()].every((variant) =>
      scalarValue(program, variant.type, inProgress),
    );
    inProgress.delete(type);
    return scalar;
  }
  if (type.kind !== "Scalar") return false;
  return (
    isStringType(program, type) ||
    numericKind(type) !== undefined ||
    scalarChain(type).some(
      (scalar) => scalar.name === "boolean" && scalar.namespace?.name === "TypeSpec",
    )
  );
}

function visible(program: Program, property: ModelProperty): boolean {
  return getVisibilityForClass(program, property, getLifecycleVisibilityEnum(program)).size > 0;
}

export function validateLocation(
  program: Program,
  message: Model,
  location: string,
  target: Type,
): void {
  const hash = location.indexOf("#");
  const source = location.slice(0, hash),
    pointer = location.slice(hash + 1);
  let current: Type | undefined =
    source === "$message.header" ? getHeadersModel(program, message) : message;
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  let valid =
    ["$message.header", "$message.payload"].includes(source) &&
    pointer.startsWith("/") &&
    !/~(?:[^01]|$)/u.test(pointer);
  for (const token of tokens) {
    if (!valid || current?.kind !== "Model") {
      valid = false;
      break;
    }
    const property: ModelProperty | undefined = [...walkPropertiesInherited(current)].find(
      (candidate) => resolveEncodedName(program, candidate, "application/json") === token,
    );
    if (
      !property ||
      property.optional ||
      !visible(program, property) ||
      (source === "$message.payload" && isHeader(program, property)) ||
      getJsonSchemaExtensions(program, property).length > 0
    ) {
      valid = false;
      break;
    }
    current = property.type;
  }

  if (!valid || current === undefined || !scalarValue(program, current)) {
    problem(
      program,
      target,
      "runtime-location",
      `Location '${location}' must name an actual required scalar application property or payload field on '${message.name}', not native AMQP properties or an unsupported recursive union.`,
    );
  }
}

export function validateMessage(program: Program, message: Model, profile: MessageProfile): void {
  for (const [name, config] of Object.entries<NativeString>({ ...profile.nativeProperties })) {
    if (config.const !== undefined && !nativeLengthAllows(config, config.const)) {
      problem(
        program,
        message,
        "profile-shape",
        `/nativeProperties/${name}/const exceeds its declared maxLength.`,
      );
    }
  }
  validatePayloadOverrides(program, message);
  const contentType = getContentType(program, message);
  if (profile.nativeProperties?.ContentType && contentType === undefined) {
    problem(
      program,
      message,
      "native-metadata",
      "Native ContentType requires explicit standard @contentType on the message.",
    );
  }
  if (contentType && !/^[^/]+\/(?:[^;]+\+)?json(?:\s*;|$)/iu.test(contentType)) {
    problem(
      program,
      message,
      "profile-unsupported",
      `Content type '${contentType}' is outside the initial native JSON profile.`,
    );
  }
  for (let current: Model | undefined = message; current; current = current.baseModel) {
    if (getRawHeaders(program, current) || getRawPayload(program, current)) {
      problem(
        program,
        message,
        "profile-unsupported",
        "Raw/multi-format payload and header schemas are not validated by profile 0.1.0.",
      );
    }
  }
  validateHeaders(program, message);
  const correlation = getCorrelationId(program, message);
  if (correlation) validateLocation(program, message, correlation.location, message);
}

function validatePayloadOverrides(program: Program, message: Model): void {
  const validateModel = (model: Model) => {
    if (
      getJsonSchemaExtensions(program, model).some(
        ({ key, value }) => key !== "additionalProperties" || typeof value !== "boolean",
      )
    ) {
      problem(
        program,
        model,
        "profile-unsupported",
        "Raw payload schema overrides other than boolean additionalProperties are outside the initial native JSON profile.",
      );
    }
  };
  navigateType(
    message,
    {
      model: validateModel,
      modelProperty: (property) => {
        if (!isHeader(program, property) && getJsonSchemaExtensions(program, property).length > 0) {
          problem(
            program,
            property,
            "profile-unsupported",
            "Raw payload property schema overrides are not validated by profile 0.1.0.",
          );
        }
      },
    },
    {},
  );
}
