export interface NativeFixture {
  readonly id: string;
  readonly field: string;
  readonly declarations?: string;
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
  readonly annotationFormats?: readonly string[];
}

export const nativeFixtures: readonly NativeFixture[] = [
  {
    id: "F01 length",
    field: "@minLength(2) @maxLength(5) value: string;",
    valid: ["AB", "ABCDE"],
    invalid: ["A", "ABCDEF"],
  },
  {
    id: "F01 pattern",
    field: '@pattern("^[A-Z]{2}[0-9]{2}$") value: string;',
    valid: ["AB12"],
    invalid: ["ab12", "AB1"],
  },
  {
    id: "F01 uuid",
    field: '@format("uuid") value: string;',
    valid: ["550e8400-e29b-41d4-a716-446655440000"],
    invalid: ["not-a-uuid"],
  },
  {
    id: "F01 datetime",
    field: "value: utcDateTime;",
    valid: ["2026-09-10T00:00:00Z"],
    invalid: ["yesterday", "2026-99-99T00:00:00Z"],
  },
  {
    id: "F02 inclusive",
    field: "@minValue(0) @maxValue(10) value: int32;",
    valid: [0, 10],
    invalid: [-1, 11, 1.5, "1"],
  },
  {
    id: "F02 exclusive",
    field: "@minValueExclusive(0) @maxValueExclusive(10) value: int32;",
    valid: [1, 9],
    invalid: [0, 10],
  },
  {
    id: "F02 int32 width",
    field: "value: int32;",
    valid: [-2147483648, 2147483647],
    invalid: [-2147483649, 2147483648],
  },
  {
    id: "F02 safeint profile",
    field: "value: safeint;",
    valid: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    invalid: [Number.MAX_SAFE_INTEGER + 1],
  },
  {
    id: "F03 collection",
    field: "@minItems(1) @maxItems(3) value: string[];",
    valid: [["a"], ["a", "b", "c"]],
    invalid: [[], ["a", "b", "c", "d"], [1]],
  },
  {
    id: "F03 named collection",
    declarations: "@minItems(1) model Names is string[];",
    field: "value: Names;",
    valid: [["a"]],
    invalid: [[], [1]],
  },
  {
    id: "F03 record",
    field: "value: Record<int32>;",
    valid: [{ a: 1, b: 2 }],
    invalid: [{ a: "1" }],
  },
  {
    id: "F05 epoch nullable",
    field: '@encode("unixTimestamp", int32) value: utcDateTime | null;',
    valid: [0, 123, null],
    invalid: ["2026-09-10T00:00:00Z", 0.5],
  },
  {
    id: "F05 duration seconds",
    field: '@encode("seconds", int32) value: duration;',
    valid: [0, 120],
    invalid: ["PT2M", 0.5],
  },
  {
    id: "F05 duration milliseconds",
    field: '@encode("milliseconds", int32) value: duration;',
    valid: [120000],
    invalid: ["PT2M", 0.5],
  },
  {
    id: "F05 duration ISO8601",
    field: '@encode("ISO8601") value: duration;',
    valid: ["PT2M"],
    invalid: ["two minutes", 120],
  },
  { id: "F05 bytes base64", field: "value: bytes;", valid: ["+/8="], invalid: ["-_8=", 12] },
  {
    id: "F05 bytes base64url",
    field: '@encode("base64url") value: bytes;',
    valid: ["-_8=", "-_8"],
    invalid: ["+/8=", "%bad"],
  },
  {
    id: "F05 boolean string representation",
    field: "@encode(string) value: boolean;",
    valid: ["true"],
    invalid: [true],
  },
  {
    id: "F05 integer string representation",
    field: "@encode(string) value: int32;",
    valid: ["123"],
    invalid: [123],
  },
  {
    id: "F05 http-date annotation",
    field: '@encode("rfc7231") value: utcDateTime;',
    annotationFormats: ["http-date"],
    valid: ["Sun, 06 Nov 1994 08:49:37 GMT"],
    invalid: [123],
  },
  {
    id: "F05 encoding leaves unrelated branch",
    field: '@encode("unixTimestamp", int32) value: utcDateTime | boolean | null;',
    valid: [123, true, null],
    invalid: ["2026-09-10T00:00:00Z"],
  },
  {
    id: "F06 mixed enum",
    declarations: 'enum Choice { a: "A", b: 2 }',
    field: "value: Choice;",
    valid: ["A", 2],
    invalid: ["B", 3],
  },
  { id: "F06 literals", field: 'value: "A" | 2;', valid: ["A", 2], invalid: ["B", 3] },
  { id: "F06 anyOf overlap", field: "value: int32 | float64;", valid: [1, 1.5], invalid: ["1"] },
  {
    id: "F06 oneOf overlap",
    declarations: "@oneOf union Number { int32, float64 }",
    field: "value: Number;",
    valid: [1.5],
    invalid: [1, "1"],
  },
  {
    id: "F07 scalar intersection",
    declarations:
      '@minLength(3) @pattern("^[a-z]+$") scalar Base extends string; @minLength(2) scalar Derived extends Base;',
    field: '@minLength(1) @pattern("^.*$") value: Derived;',
    valid: ["abc"],
    invalid: ["ab", "ABC"],
  },
];
