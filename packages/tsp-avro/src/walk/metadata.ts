import {
  getDiscriminatedUnion,
  getDiscriminator,
  getEncode,
  getFormat,
  getLifecycleVisibilityEnum,
  getMaxItemsAsNumeric,
  getMaxLengthAsNumeric,
  getMaxValueAsNumeric,
  getMaxValueExclusiveAsNumeric,
  getMaxValueExclusiveForScalar,
  getMaxValueForScalar,
  getMinItemsAsNumeric,
  getMinLengthAsNumeric,
  getMinValueAsNumeric,
  getMinValueExclusiveAsNumeric,
  getMinValueExclusiveForScalar,
  getMinValueForScalar,
  getPattern,
  getVisibilityForClass,
  type Program,
  type Type,
} from "@typespec/compiler";

/** Compiler semantics with no mapping in the generated Avro 1.9 schema. */
export function unsupportedAvroMetadata(program: Program, type: Type): string[] {
  const constraints: [string, unknown][] = [
    ["@minLength", getMinLengthAsNumeric(program, type)],
    ["@maxLength", getMaxLengthAsNumeric(program, type)],
    ["@minItems", getMinItemsAsNumeric(program, type)],
    ["@maxItems", getMaxItemsAsNumeric(program, type)],
    ["@minValue", getMinValueAsNumeric(program, type) ?? getMinValueForScalar(program, type)],
    ["@maxValue", getMaxValueAsNumeric(program, type) ?? getMaxValueForScalar(program, type)],
    [
      "@minValueExclusive",
      getMinValueExclusiveAsNumeric(program, type) ?? getMinValueExclusiveForScalar(program, type),
    ],
    [
      "@maxValueExclusive",
      getMaxValueExclusiveAsNumeric(program, type) ?? getMaxValueExclusiveForScalar(program, type),
    ],
    ["@pattern", getPattern(program, type)],
    ["@format", getFormat(program, type)],
  ];
  const unsupported = constraints.filter(([, value]) => value !== undefined).map(([name]) => name);
  if (
    (type.kind === "Scalar" || type.kind === "ModelProperty") &&
    getEncode(program, type) !== undefined
  ) {
    unsupported.push("@encode");
  }
  if (type.kind === "ModelProperty") {
    const lifecycle = getLifecycleVisibilityEnum(program);
    if (getVisibilityForClass(program, type, lifecycle).size < lifecycle.members.size) {
      unsupported.push("restricted lifecycle visibility");
    }
  }
  if (
    (type.kind === "Model" || type.kind === "Union") &&
    getDiscriminator(program, type) !== undefined
  ) {
    unsupported.push("@discriminator");
  }
  if (type.kind === "Union" && getDiscriminatedUnion(program, type)[0] !== undefined) {
    unsupported.push("@discriminated");
  }
  return unsupported;
}
