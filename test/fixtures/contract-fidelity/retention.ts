import type { SchemaObject } from "#emitter/types/index.js";
import type { JsonMessage } from "../../utils/evolution.js";
import {
  retentionSource,
  type MessageShape,
  type RetentionVersion,
  type ThreeVersions,
} from "../../utils/retained-messages.js";

export interface RetainedWitness {
  readonly name: string;
  readonly producer: RetentionVersion;
  readonly message: JsonMessage;
  /** Consumer v1, v2, v3, in that order. Producers always use the open profile. */
  readonly tolerant: ThreeVersions<boolean>;
  readonly strict: ThreeVersions<boolean>;
}

export interface RetentionFixture {
  readonly id: string;
  readonly source: string;
  readonly shapes: ThreeVersions<MessageShape>;
  readonly witnesses: readonly RetainedWitness[];
}

const text: SchemaObject = { type: "string" };
const integer: SchemaObject = { type: "integer", format: "int32" };
const all: ThreeVersions<boolean> = [true, true, true];
const body = (
  fields: Record<string, unknown> = {},
  headers?: Record<string, unknown>,
): JsonMessage => ({
  payload: { id: "sample", ...fields },
  ...(headers === undefined ? {} : { headers }),
});
const shape = (
  properties: Readonly<Record<string, SchemaObject>> = {},
  required = Object.keys(properties),
): MessageShape => ({
  payload: { properties: { id: text, ...properties }, required: ["id", ...required] },
});
const witness = (
  producer: RetentionVersion,
  name: string,
  message: JsonMessage,
  tolerant: ThreeVersions<boolean>,
  strict = tolerant,
): RetainedWitness => ({ producer, name, message, tolerant, strict });
const enumeration = (values: readonly string[]): SchemaObject => ({
  type: "string",
  enum: [...values],
});
const interval = (minimum: number, maximum: number): SchemaObject => ({
  ...integer,
  minimum,
  maximum,
});

export const retentionFixtures: readonly RetentionFixture[] = [
  {
    id: "R01 optional addition is not universally safe",
    source: retentionSource("@added(Versions.v2) note?: string;"),
    shapes: [shape(), shape({ note: text }, []), shape({ note: text }, [])],
    witnesses: [
      witness("1.0", "retained declared fields", body(), all),
      witness(
        "1.0",
        "retained open-producer name collision",
        body({ note: 42 }),
        [true, false, false],
        [false, false, false],
      ),
      witness("2.0", "new optional field", body({ note: "two" }), all, [false, true, true]),
      witness("3.0", "later optional field", body({ note: "three" }), all, [false, true, true]),
    ],
  },
  {
    id: "R02 required addition is not rescued by a JSON default",
    source: retentionSource('@added(Versions.v2) note: string = "fallback";'),
    shapes: [
      shape(),
      shape({ note: { ...text, default: "fallback" } }),
      shape({ note: { ...text, default: "fallback" } }),
    ],
    witnesses: [
      witness("1.0", "retained missing required field", body(), [true, false, false]),
      witness("2.0", "explicit value", body({ note: "two" }), all, [false, true, true]),
      witness("3.0", "later explicit value", body({ note: "three" }), all, [false, true, true]),
    ],
  },
  {
    id: "R03a optional becomes required",
    source: retentionSource("@madeRequired(Versions.v2) note: string;"),
    shapes: [shape({ note: text }, []), shape({ note: text }), shape({ note: text })],
    witnesses: [
      witness("1.0", "retained omission across two deployments", body(), [true, false, false]),
      witness("2.0", "present field", body({ note: "two" }), all),
      witness("3.0", "later present field", body({ note: "three" }), all),
    ],
  },
  {
    id: "R03b required becomes optional",
    source: retentionSource("@madeOptional(Versions.v2) note?: string;"),
    shapes: [shape({ note: text }), shape({ note: text }, []), shape({ note: text }, [])],
    witnesses: [
      witness("1.0", "retained required field", body({ note: "one" }), all),
      witness("2.0", "omission after relaxation", body(), [false, true, true]),
      witness("3.0", "later omission", body(), [false, true, true]),
    ],
  },
  {
    id: "R04 removal needs unknown-field tolerance and does not rewrite data",
    source: retentionSource("@removed(Versions.v2) legacy: string;"),
    shapes: [shape({ legacy: text }), shape(), shape()],
    witnesses: [
      witness("1.0", "retained removed field", body({ legacy: "keep me" }), all, [
        true,
        false,
        false,
      ]),
      witness("2.0", "field no longer produced", body(), [false, true, true]),
      witness("3.0", "later producer still omits it", body(), [false, true, true]),
    ],
  },
  {
    id: "R05 successive wire renames do not migrate queued values",
    source: retentionSource(
      '@renamedFrom(Versions.v2, "legacy") @renamedFrom(Versions.v3, "middle") current: string;',
    ),
    shapes: [shape({ legacy: text }), shape({ middle: text }), shape({ current: text })],
    witnesses: [
      witness("1.0", "retained first name", body({ legacy: "original" }), [true, false, false]),
      witness("2.0", "intermediate name", body({ middle: "second" }), [false, true, false]),
      witness("3.0", "latest name", body({ current: "third" }), [false, false, true]),
    ],
  },
  {
    id: "R06 enum expansion then removal",
    source: retentionSource(
      "kind: Kind;",
      `
      enum Kind {
        Stable: "stable",
        @removed(Versions.v3) Legacy: "legacy",
        @added(Versions.v2) Modern: "modern"
      }
    `,
    ),
    shapes: [
      shape({ kind: enumeration(["stable", "legacy"]) }),
      shape({ kind: enumeration(["stable", "legacy", "modern"]) }),
      shape({ kind: enumeration(["stable", "modern"]) }),
    ],
    witnesses: [
      witness("1.0", "retained removed enum member", body({ kind: "legacy" }), [true, true, false]),
      witness("1.0", "retained stable member", body({ kind: "stable" }), all),
      witness("2.0", "new member", body({ kind: "modern" }), [false, true, true]),
      witness("3.0", "current stable member", body({ kind: "stable" }), all),
    ],
  },
  {
    id: "R07 scalar constraints tighten then loosen",
    source: retentionSource(
      "@typeChangedFrom(Versions.v2, Wide) @typeChangedFrom(Versions.v3, Tight) amount: Relaxed;",
      `
      @minValue(0) @maxValue(100) scalar Wide extends int32;
      @minValue(10) @maxValue(90) scalar Tight extends int32;
      @minValue(0) @maxValue(200) scalar Relaxed extends int32;
    `,
    ),
    shapes: [
      shape({ amount: interval(0, 100) }),
      shape({ amount: interval(10, 90) }),
      shape({ amount: interval(0, 200) }),
    ],
    witnesses: [
      witness("1.0", "retained lower endpoint", body({ amount: 0 }), [true, false, true]),
      witness("1.0", "retained upper endpoint", body({ amount: 100 }), [true, false, true]),
      witness("2.0", "tight endpoint", body({ amount: 10 }), all),
      witness("3.0", "newly widened domain", body({ amount: 150 }), [false, false, true]),
    ],
  },
  {
    id: "R08 wire type then nullability without coercion",
    source: retentionSource(
      "@typeChangedFrom(Versions.v2, string) @typeChangedFrom(Versions.v3, int32) value: int32 | null;",
    ),
    shapes: [
      shape({ value: text }),
      shape({ value: integer }),
      shape({ value: { anyOf: [integer, { type: "null" }] } }),
    ],
    witnesses: [
      witness("1.0", "retained numeric text", body({ value: "12" }), [true, false, false]),
      witness("2.0", "integer value", body({ value: 12 }), [false, true, true]),
      witness("3.0", "new null value", body({ value: null }), [false, false, true]),
    ],
  },
  {
    id: "R09 optional header addition then required header",
    source: retentionSource(
      "@header @added(Versions.v2) @madeRequired(Versions.v3) trace: string;",
    ),
    shapes: [
      shape(),
      { ...shape(), headers: { properties: { trace: text }, required: [] } },
      { ...shape(), headers: { properties: { trace: text }, required: ["trace"] } },
    ],
    witnesses: [
      witness("1.0", "retained message without headers", body(), [true, true, false]),
      witness(
        "1.0",
        "retained unknown header collision",
        body({}, { trace: 42 }),
        [true, false, false],
        [false, false, false],
      ),
      witness("2.0", "optional header supplied", body({}, { trace: "two" }), all, [
        false,
        true,
        true,
      ]),
      witness("3.0", "required header supplied", body({}, { trace: "three" }), all, [
        false,
        true,
        true,
      ]),
    ],
  },
];
