---
title: "Contract Fidelity and Evolution"
description: "What emitted payload validation and independent producer/consumer fixtures establish, and what they do not."
---

# Contract fidelity and evolution

An AsyncAPI document can parse successfully while admitting an invalid message.
The contract suites keep four independent layers of evidence: TypeSpec diagnostics,
document/schema parsing, supplied payload **and application-header** acceptance,
and old-writer/new-reader serialization. A snapshot or successful binary decode
alone does not establish source-contract preservation.

## Validated dialects

| Lane                                       | Generated contracts            | Authored contracts                          | Instance evidence                                                  |
| ------------------------------------------ | ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------ |
| Native AsyncAPI 3.1 / JSON Schema draft-07 | Supported subset below         | AsyncAPI and draft-07 JSON/YAML identifiers | Isolated Ajv + ajv-formats, retained recursive references          |
| Avro 1.9.0                                 | Preview Avro record conversion | Avro object schemas                         | avsc writer encoding and independent reader resolution             |
| Protobuf 3                                 | Preview self-contained proto3  | Authored proto3 text                        | protobufjs independently parsed writer/reader, explicit root       |
| Protobuf 2                                 | No generated lane              | Focused authored proto2                     | Required fields and defaults, not a generated proto2 promise       |
| OpenAPI 3.0, RAML 1.0, other identifiers   | No conversion claim            | Identifier/representation pass-through      | Not validated as draft-07; the instance helper refuses these lanes |

Accepting fourteen `schemaFormat` identifiers is not evidence of fourteen
payload-validation implementations. The wrapper's media type and schema syntax
are separate assertions. Both JSON and YAML document serialization are exercised
for native, generated Avro and generated proto3 payloads.

## Supported-feature matrix

| IDs | Native JSON witnesses                                                                                                           | Binary evidence or explicit limitation                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| F01 | Length endpoints, patterns, UUID and date-time, format profiles                                                                 | Unsupported source constraints/formats refuse generated artifacts                                                 |
| F02 | Inclusive/exclusive bounds, fractions, signed widths, safe-number boundaries                                                    | Exact supported integer/byte representations; wider values use codec-specific representations                     |
| F03 | Item bounds, item types, named arrays, records                                                                                  | Supported arrays/maps; constrained or indexed-record shapes are refused where unsupported                         |
| F04 | Required/optional, nullable/nonnullable, defaults without injection                                                             | Avro null/default resolution; proto3 wire presence is not TypeSpec requiredness; explicit source defaults refused |
| F05 | Epoch, duration, bytes alphabets, encoded string representation, nullable branches, defaults/examples, scalar-chain constraints | Source `@encode` is refused rather than silently ignored by binary conversion                                     |
| F06 | Literals/enums, overlapping anyOf/oneOf, empty sets, discriminated envelopes                                                    | Avro branch restrictions, enum/default behavior; protobuf numeric enums, unsupported unions                       |
| F07 | Layered scalar/model inheritance, inherited required fields, recursive references and shared components                         | Recursive binary records/messages; unsupported inheritance refused; explicit protobuf root and descriptor parity  |
| F08 | Own, spread and lifting-message inherited headers; explicit separate headers, encoded names and independent failures            | Separate native headers retained beside binary payloads; generated payload lifting refused                        |
| F09 | Actual dialect compilation, malformed schemas, escaped/missing/circular refs, per-document registries                           | Authored/generated controls; unsupported dialects do not count as validated                                       |
| F10 | Opaque scalar, visibility, numeric/temporal limitations, schema-extension and encoding diagnostics                              | Actionable metadata/refusal diagnostics with source targets/counts; Avro logical metadata checked separately      |

An inherited `@header` from an **unmarked** base is not lifted: the existing
`inherited-header-ignored` warning keeps that field in the payload. A base that
is itself a lifting `@message` propagates its headers; spreading also makes a
field the message's own. No change to these rules is implied by the matrix.

New native warnings make previously silent limitations visible:
`unmapped-schema-scalar`, `unsupported-encoded-constraint`,
`unsupported-schema-keyword`, and `schema-extension-overrides-contract`.
Malformed known extension keywords report `invalid-schema-extension` errors.
Encoding rewrites every scalar `allOf` level; constraints for the old wire type
are omitted with a warning, not left as meaningless bounds or contradictory types.
Nullable unions are inspected by branch domain, including known scalar references
and their inherited encodings without changing shared components. Constraints
that still apply to another branch remain in place; genuinely unknown reference
domains stay conservative. An authored `$ref` also warns when it
displaces generated validation siblings. Enum equality ignores object-key order,
and later-draft keywords are detected inside schema-valued `dependencies`.
No numeric-to-string range regex or universal conversion solver is invented.

## Consumer profiles and evolution

The primary JSON profile is **open, format-asserting**: unknown object properties
remain allowed, known formats are asserted, enums reject unknown values, and
`coerceTypes`, `useDefaults`, and `removeAdditional` are all false. Neither
defaults nor failed validation mutate input. A **closed** profile separately
lists consumer-known fields at explicit object paths. It does not attach
`additionalProperties: false` to an `allOf` and mistake inherited fields for
unknown ones. A **format-annotation** profile intentionally ignores formats.

The native/draft-07 oracle ignores validation siblings of `$ref`; meaningful
additional constraints belong in an `allOf` wrapper. It explicitly rejects
OpenAPI `nullable` at schema positions rather than extending the dialect.
Opaque annotations are removed only from the nonmutating compilation view, so
their `$id` values cannot register schemas or resolve live references. Real
schema identifiers, recursive references and literal `const`/`enum` data remain.
Absent optional headers default to an empty object for validation; explicit
`null` does not and fails an object header schema.

Unknown validation keywords and formats fail helper compilation unless explicitly
declared annotation-only. `http-date` is one such declared lexical limitation.
Numeric/boolean string encodings establish the string representation, not a
canonical lexical grammar. Integer width formats are assertions in this profile,
not a promise that every JSON consumer enforces them. JSON numeric witnesses
stay within JavaScript safe precision; decimal128 and full int64/uint64 precision
are not proved by JavaScript-number validation.

Every independent-release mutation runs P1→C1, P1→C2, P2→C1 and P2→C2.
The writer must accept its witness before serialization. Fixtures E01–E10 cover
optional/required additions, defaults, optionality, removals, wire-name changes,
aliases, enums, tightening/loosening constraints, changed types/encodings/tags,
and payload/header/envelope changes. Results distinguish rejection from retained
values and successful reading with loss or defaulting.

**Even an optional addition is not universally safe.** An old open contract
with only `id: string` accepts `{ id: "a", note: 42 }`. Adding
`note?: string` rejects that old-valid message. Conversely, a new string `note`
is accepted by an old open consumer but rejected by a closed consumer.
JSON required-field defaults do not rescue old messages: no default is injected.

Avro uses stable full names and `reader.createResolver(writer)`, with
`wrapUnions: false`. Unknown writer fields are skipped; aliases are directional;
reader defaults and enum fallback are asserted as exact values, not called
value-preserving. Unsupported reader/writer pairs can fail during resolver
construction or when a particular union/enum branch is read.
Generated defaults are checked recursively against the completed Avro schema
graph, including named records, arrays, maps and each nested union's first
branch. An outer default never reorders a shared nested union. Invalid or
infinitely expanding defaults report `tsp-avro/invalid-default` and refuse output.

Protobuf uses separate roots with `keepCase: true`; the root message is selected
explicitly. Values, own-field presence, unknown numeric enums and tag loss are
asserted independently. Missing singular fields may decode successfully despite
violating source-required semantics. An old reader can discard unknown tags on
decode/re-encode. A separate closed-enum application policy rejects unknown
numbers. Binary name/tag compatibility does not establish ProtoJSON compatibility.
Explicit source metadata is checked throughout a Protobuf scalar's ancestry,
even beyond the nearest supported wire mapping; implicit wire mappings remain
supported.

Avro logical-type names, units, decimal precision/scale and fixed sizes are
asserted on the emitted schema. avsc without custom logical adapters does not
prove those semantics. `local-timestamp-*` is refused because it is not part of
the advertised Avro 1.9.0 dialect.

## Version-generated retained messages

The retention suites use real TypeSpec `@versioned` v1/v2/v3 views through the
[versioning adapter](../versioning.md), not edited copies of JSON schemas.
Before any acceptance assertion, they check the exact output set
`asyncapi.1.0.json`, `asyncapi.2.0.json`, `asyncapi.3.0.json`, each selected
`info.version`, the AsyncAPI **3.1.0** target, and live payload/header fields,
required sets, enum members, types and constraint bounds.

Each JSON witness is admitted by its **producer snapshot** and serialized once
with `readJson`. The resulting value and serialized text are retained and reused
unchanged by every consumer. No consumer-shaped reconstruction, renaming,
coercion, default injection or removal of unknown fields occurs. The ten
individually attributable fixtures contain 34 produced records and 204 consumer
outcomes (three versions, two policies), including 70 expected rejections.

| Case        | Version-generated change                                | Retention evidence                                                                                            |
| ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| R01         | Optional field added in v2                              | A declared-only v1 message survives; an old-valid `note: 42` collides with the new optional string.           |
| R02         | Required field with a default added in v2               | The v1 omission fails in v2 and v3; a JSON default does not repair it.                                        |
| R03a / R03b | Optional-to-required / required-to-optional             | Separate fixtures expose each direction without one change masking another.                                   |
| R04         | Required field removed in v2                            | Tolerant readers accept the old extra field without rewriting it; old readers reject new messages missing it. |
| R05         | A property renamed in both v2 and v3                    | Old, intermediate and current names stay distinct; queued values are not migrated.                            |
| R06         | Enum member added in v2, another removed in v3          | A v1 legacy value survives v2 but fails v3; a new member fails the old consumer.                              |
| R07         | Integer bounds tightened in v2, widened in v3           | Retained endpoints fail the intermediate deployment; newly widened values fail older consumers.               |
| R08         | String changes to integer, then integer-or-null         | Numeric text is not coerced, and null is admitted only by its actual snapshot.                                |
| R09         | Optional application header added in v2, required in v3 | Header omissions and unknown-name collisions fail independently of the unchanged payload.                     |

**Tolerant** means open to unknown payload/header fields, not tolerant of wrong
types, missing required fields, unknown enums, invalid formats or violated bounds.
**Strict** applies the same schema checks plus explicit consumer-known field sets
for payload and headers; a version with no declared headers knows no header names.
All fixture producers use the open profile. Consequently, an open producer's
extra-field witness can fail even a same-version strict consumer.

A separate deployment control selects `"1.0"`, then `"2.0"` and `"3.0"` in
independent emissions. The exact same queued v1 `amount: 0` is rejected by v2's
minimum of 10 and accepted by v3's minimum of 0. This assumes the original record
is still available; it does not claim that a broker retained it after an earlier
consumer attempted delivery.

Bounded version-generated **Avro 1.9** and **proto3** controls also capture writer
bytes once and read the same bytes with independently constructed v1/v2/v3 codecs.
Avro asserts exact reader defaults (`note: null`, `generation: 0`), dropped fields
and two resolver refusals when the required v3 field lacks a default. A v1 relay
loses v3 content; later defaults do not restore its original values. Protobuf
asserts unknown-tag loss and absent own-field presence. Decoding v1 bytes under
v3 succeeds, but the native v3 view of the **same TypeSpec source** rejects the
missing source-required `generation` field. These are semantic-content assertions
separate from the unchanged retained bytes, not a promise of byte-preserving
decode/re-encode.

The broader [independent binary writer/reader matrix](https://github.com/cataggar/tsp-asyncapi/blob/main/test/integration/contract-binary-evolution.test.ts)
continues to cover aliases, enums, type/tag changes and reader/writer restrictions;
the retention controls do not duplicate or expand that capability claim.
The harness retains the producer schema and codec identity alongside each record
(Avro resolution requires the writer schema). It models no schema-registry
availability, application migration, broker storage or delivery operation.

## Scope and running the evidence

The existing Vitest runner auto-discovers `contract-fidelity`,
`contract-native-diagnostics`, `contract-encoded-union-references`,
`contract-validator-draft07`, `contract-evolution`, `contract-binary-fidelity`
and `contract-binary-evolution`, plus `contract-versioned-retention` and
`contract-versioned-binary-retention`. The data rows live in
`test/fixtures/contract-fidelity`; binary pairs carry their expected values in
their suite. Expected negatives are ordinary assertions, not skipped tests.
Generated numeric witnesses are bounded and use seed `3107`.

Use Node 24 and the workspace pnpm version (the locked TypeSpec compiler requires
Node 22 or newer), build first, then run the selected contract suites.
The validators are test utilities, not emitter runtime dependencies.

These finite witnesses are counterexamples or evidence for a named consumer
profile, **not** a proof of schema-language inclusion, compatibility with every
client, or safety across every historic producer. Independent old/new compilations
and the real version-generated retention matrix establish different evidence;
neither establishes compatibility for every queued message or retention window.

AsyncAPI uses native draft-07, nullable unions and its own discriminator shape;
it is not OpenAPI 3.0 `nullable` or HTTP request/response visibility projection.
Partial lifecycle visibility does not select send/receive shapes. JSON encoded
names are media-type-specific and are not binary field aliases.
Application headers are not broker-native metadata. No fixture proves delivery,
ordering, TTL, settlement, retries, exactly-once processing, deduplication,
idempotency or business meaning.
