import type { JsonMessage } from "../../utils/evolution.js";

export interface ReleaseFixture {
  readonly id: string;
  readonly old: string;
  readonly next: string;
  readonly oldValues: readonly [JsonMessage, boolean][];
  readonly nextValues: readonly [JsonMessage, boolean][];
}

const model = (fields: string) => `@message model Event { ${fields} }`;
const payload = (value: unknown): JsonMessage => ({ payload: value });
const mutation = (
  id: string,
  old: string,
  next: string,
  oldValues: readonly [unknown, boolean][],
  nextValues: readonly [unknown, boolean][],
): ReleaseFixture => ({
  id,
  old: model(old),
  next: model(next),
  oldValues: oldValues.map(([value, accepted]) => [payload(value), accepted]),
  nextValues: nextValues.map(([value, accepted]) => [payload(value), accepted]),
});

export const releases: readonly ReleaseFixture[] = [
  mutation(
    "E01 optional addition",
    "id: string;",
    "id: string; note?: string;",
    [
      [{ id: "a" }, true],
      [{ id: "a", note: 42 }, false],
    ],
    [
      [{ id: "a" }, true],
      [{ id: "a", note: "text" }, true],
    ],
  ),
  mutation(
    "E02 required addition",
    "id: string;",
    "id: string; note: string;",
    [[{ id: "a" }, false]],
    [[{ id: "a", note: "text" }, true]],
  ),
  mutation(
    "E03 required default",
    "id: string;",
    'id: string; note: string = "default";',
    [[{ id: "a" }, false]],
    [[{ id: "a", note: "text" }, true]],
  ),
  mutation(
    "E04 optional to required",
    "id: string; note?: string;",
    "id: string; note: string;",
    [
      [{ id: "a" }, false],
      [{ id: "a", note: "text" }, true],
    ],
    [[{ id: "a", note: "text" }, true]],
  ),
  mutation(
    "E04 required to optional",
    "id: string; note: string;",
    "id: string; note?: string;",
    [[{ id: "a", note: "text" }, true]],
    [
      [{ id: "a" }, false],
      [{ id: "a", note: "text" }, true],
    ],
  ),
  mutation(
    "E05 optional removal",
    "id: string; note?: string;",
    "id: string;",
    [
      [{ id: "a" }, true],
      [{ id: "a", note: "text" }, true],
    ],
    [
      [{ id: "a" }, true],
      [{ id: "a", note: 42 }, false],
    ],
  ),
  mutation(
    "E05 required removal",
    "id: string; note: string;",
    "id: string;",
    [[{ id: "a", note: "text" }, true]],
    [[{ id: "a" }, false]],
  ),
  mutation(
    "E06 rename",
    "id: string;",
    "key: string;",
    [[{ id: "a" }, false]],
    [[{ key: "a" }, false]],
  ),
  mutation(
    "E06 stable wire rename",
    "id: string;",
    '@encodedName("application/json", "id") key: string;',
    [[{ id: "a" }, true]],
    [[{ id: "b" }, true]],
  ),
  mutation(
    "E07 enum addition",
    'value: "A" | "B";',
    'value: "A" | "B" | "C";',
    [
      [{ value: "A" }, true],
      [{ value: "B" }, true],
    ],
    [
      [{ value: "A" }, true],
      [{ value: "C" }, false],
    ],
  ),
  mutation(
    "E07 enum removal",
    'value: "A" | "B" | "C";',
    'value: "A" | "B";',
    [
      [{ value: "A" }, true],
      [{ value: "C" }, false],
    ],
    [[{ value: "B" }, true]],
  ),
  mutation(
    "E08 minLength",
    "@minLength(2) value: string;",
    "@minLength(3) value: string;",
    [
      [{ value: "ab" }, false],
      [{ value: "abc" }, true],
    ],
    [[{ value: "abc" }, true]],
  ),
  mutation(
    "E08 maxLength",
    "@maxLength(8) value: string;",
    "@maxLength(5) value: string;",
    [
      [{ value: "abcdef" }, false],
      [{ value: "abcde" }, true],
    ],
    [[{ value: "abcde" }, true]],
  ),
  mutation(
    "E08 numeric interval",
    "@minValue(0) @maxValue(100) value: int32;",
    "@minValue(10) @maxValue(90) value: int32;",
    [
      [{ value: 0 }, false],
      [{ value: 100 }, false],
      [{ value: 10 }, true],
    ],
    [[{ value: 90 }, true]],
  ),
  mutation(
    "E08 exclusive bound",
    "@minValue(0) value: int32;",
    "@minValueExclusive(0) value: int32;",
    [
      [{ value: 0 }, false],
      [{ value: 1 }, true],
    ],
    [[{ value: 1 }, true]],
  ),
  mutation(
    "E08 array bounds",
    "@minItems(0) @maxItems(3) value: int32[];",
    "@minItems(1) @maxItems(2) value: int32[];",
    [
      [{ value: [] }, false],
      [{ value: [1, 2, 3] }, false],
      [{ value: [1] }, true],
    ],
    [[{ value: [1, 2] }, true]],
  ),
  mutation(
    "E08 pattern tightening",
    '@pattern("^[a-z]+$") value: string;',
    '@pattern("^[a-z]{3,}$") value: string;',
    [
      [{ value: "ab" }, false],
      [{ value: "abc" }, true],
    ],
    [[{ value: "abc" }, true]],
  ),
  mutation(
    "E08 disjoint pattern",
    '@pattern("^[a-z]+$") value: string;',
    '@pattern("^[A-Z]+$") value: string;',
    [[{ value: "a" }, false]],
    [[{ value: "A" }, false]],
  ),
  mutation(
    "E09 wire type",
    "value: string;",
    "value: int32;",
    [[{ value: "1" }, false]],
    [[{ value: 1 }, false]],
  ),
  mutation(
    "E09 datetime to epoch",
    "value: utcDateTime;",
    '@encode("unixTimestamp", int32) value: utcDateTime;',
    [[{ value: "2020-01-01T00:00:00Z" }, false]],
    [[{ value: 1577836800 }, false]],
  ),
  mutation(
    "E09 nullable",
    "value: string | null;",
    "value: string;",
    [
      [{ value: null }, false],
      [{ value: "a" }, true],
    ],
    [[{ value: "a" }, true]],
  ),
  mutation(
    "E09 bytes alphabet",
    "value: bytes;",
    '@encode("base64url") value: bytes;',
    [
      [{ value: "+/8=" }, false],
      [{ value: "YWJj" }, true],
    ],
    [
      [{ value: "-_8=" }, false],
      [{ value: "YWJj" }, true],
    ],
  ),
  mutation(
    "E09 numeric narrowing",
    "value: int32;",
    "value: int16;",
    [
      [{ value: 32768 }, false],
      [{ value: 1 }, true],
    ],
    [[{ value: 32767 }, true]],
  ),
  {
    id: "E10 required header addition",
    old: model("id: string;"),
    next: model("@header trace: string; id: string;"),
    oldValues: [[payload({ id: "a" }), false]],
    nextValues: [[{ payload: { id: "a" }, headers: { trace: "t" } }, true]],
  },
  {
    id: "E10 optional header removal",
    old: model("@header trace?: string; id: string;"),
    next: model("id: string;"),
    oldValues: [[{ payload: { id: "a" }, headers: { trace: "t" } }, true]],
    nextValues: [[payload({ id: "a" }), true]],
  },
  {
    id: "E10 required header removal",
    old: model("@header trace: string; id: string;"),
    next: model("id: string;"),
    oldValues: [[{ payload: { id: "a" }, headers: { trace: "t" } }, true]],
    nextValues: [[payload({ id: "a" }), false]],
  },
  {
    id: "E10 optional header addition",
    old: model("id: string;"),
    next: model("@header trace?: string; id: string;"),
    oldValues: [
      [payload({ id: "a" }), true],
      [{ payload: { id: "a" }, headers: { trace: 42 } }, false],
    ],
    nextValues: [
      [payload({ id: "a" }), true],
      [{ payload: { id: "a" }, headers: { trace: "t" } }, true],
    ],
  },
  {
    id: "E10 move payload to headers",
    old: model("id: string;"),
    next: model("@header id: string;"),
    oldValues: [[payload({ id: "a" }), false]],
    nextValues: [[{ payload: {}, headers: { id: "a" } }, false]],
  },
  {
    id: "E10 envelope key",
    old: "@discriminated union Pet { cat: Cat } model Cat { meow: boolean; } " + model("pet: Pet;"),
    next:
      '@discriminated(#{ discriminatorPropertyName: "tag", envelopePropertyName: "body" }) union Pet { cat: Cat } model Cat { meow: boolean; } ' +
      model("pet: Pet;"),
    oldValues: [[payload({ pet: { kind: "cat", value: { meow: true } } }), false]],
    nextValues: [[payload({ pet: { tag: "cat", body: { meow: true } } }), false]],
  },
];
