# OpenAPI 3.1 preparation fixtures

This is the HTTP validation prerequisite for issue #6, not the completed HTTP/Service Bus
example. It needs no Azure resources or credentials and introduces no Service Bus API.

Use Node 24 and pnpm 11.21.0. TypeSpec compiler, HTTP, OpenAPI, and OpenAPI3 resolve to
1.16.0 in the lockfile; the three HTTP/OpenAPI libraries are exact development dependencies.
The workspace and its packages require Node >=22.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm exec vitest run test/integration/openapi-validation.test.ts
```

## Reusable interfaces

- `test/utils/openapi-emitter.ts`: `emitOpenAPI31(source)` accepts one source string
  or a file map containing `main.tsp`. Imports remain exactly as authored; other
  files are not automatically imported. It requires a diagnostic-free compilation,
  exactly `openapi.yaml` and `openapi.json`, and OpenAPI version `3.1.0`.
  It returns `{document, yaml, json}`.
- `test/utils/openapi-validation.ts`: `validateOpenAPI31Document(document)` returns
  `null` or a reason-specific failure string. It checks the official document
  structure, Schema Object vocabulary, schema compilability, local `$ref` existence,
  schema-reference targets, and named security requirements.
- `compileOpenAPI31Schema(document, pointer)` separately returns an Ajv instance
  validator for an actual Schema Object in that document. It throws for an invalid
  document or a pointer to something other than a schema. Formats are registered;
  coercion, default insertion, and additional-property removal are disabled.
  Every document gets an independent reference registry.

The options below are exercised against `@typespec/openapi3` 1.16.0, rather than
inferred from another emitter. Both formats can be emitted in one compilation:

```yaml
emit:
  - "@typespec/openapi3"
options:
  "@typespec/openapi3":
    openapi-versions: ["3.1.0"]
    file-type: ["yaml", "json"]
    output-file: "openapi.{file-type}"
```

The HTTP source is `http/main.tsp`. Its `.invalid` server is an inert placeholder.
The suite proves actual source compilation and YAML/JSON parity, not only the
acceptance of a hand-written document.

## Validation boundary

The supported input is a self-contained OpenAPI 3.1 document using the OpenAPI base
dialect (its `base` or `2024-11-10` identifier), which extends JSON Schema 2020-12.
Other dialect declarations fail explicitly. Schema-local `$id`, `$anchor`,
`$dynamicAnchor`, `$dynamicRef`, non-local references, and unregistered formats are
unsupported rather than silently interpreted using another scope or dialect.
No resolver downloads resources. Ordinary external links are annotations, not
resources the validator retrieves.

The official document schema uses a nested `#meta` dynamic anchor for Schema Objects.
Ajv 8.20 resolves that slot to the document root, rejecting a valid `{type:"string"}`.
For this fixed-dialect validator, a copy of the official schema replaces those
dynamic references with direct references to its schema slot, and that slot checks
the pinned OpenAPI dialect. The upstream bytes are unchanged. Positive and negative
controls cover this adapter, inline/component schemas, recursion, and references.

`ajv-formats` supplies standard formats, including UUID and int32. A local
`media-range` checker covers the format used by the official document schema,
following RFC 9110 token, quoted-string, and wildcard rules.

Document/schema validation does **not** validate example/default values as instances.
Use the separate instance validator for payload acceptance. Data inside examples,
defaults, and specification extensions is not walked as a reference graph. Unknown
schema annotations do not acquire custom runtime semantics. Instance compilation
uses a separate representation containing supported assertions and schema children
at their original document-local paths. It excludes annotation data from Ajv's
identifier indexing, so an example or extension containing `$id` or `$anchor` cannot
replace a schema or cause an anchor error. Literal `const`/`enum` values and property
names remain intact, and the input document is never mutated.

The OpenAPI 3.0 `nullable` keyword is treated as annotation data, not an assertion:
`{type: "string", nullable: true}` rejects null, while
`{type: "null", nullable: false}` accepts it. OpenAPI 3.1 null acceptance comes from
the actual `type` or schema alternatives, such as `type: ["string", "null"]`.

This is not a complete OpenAPI semantic linter: for example, link `operationRef`/discriminator mapping
semantics, operation-ID uniqueness, and agreement between a path template and
parameters are outside this helper.

These tests do not prove HTTP authentication, authorization, delivery, application
idempotency, schema inclusion, or compatibility between independently evolving
services. The shared Order and approved profile-backed example remains follow-up
work after the Service Bus companion is available.

## Official resource provenance

All files under `3.1/` are copied verbatim from
[`OAI/spec.openapis.org` at `ff18fbf54d8cdb721f0bf26e317f5ad4090f3da8`](https://github.com/OAI/spec.openapis.org/tree/ff18fbf54d8cdb721f0bf26e317f5ad4090f3da8).
The Apache-2.0 license is retained as `3.1/LICENSE`. JSON Schema 2020-12 core
meta-schemas come from the existing, locked Ajv dependency.

| Local file                | Upstream path                |
| ------------------------- | ---------------------------- |
| `schema.json`             | `oas/3.1/schema/2025-11-23`  |
| `dialect.json`            | `oas/3.1/dialect/base`       |
| `meta.json`               | `oas/3.1/meta/base`          |
| `dialect-2024-11-10.json` | `oas/3.1/dialect/2024-11-10` |
| `meta-2024-11-10.json`    | `oas/3.1/meta/2024-11-10`    |
| `LICENSE`                 | `LICENSE`                    |

The integration suite pins SHA-256 hashes of every resource, including the license.
Prettier ignores the JSON resources to preserve upstream bytes. Update the source
revision, paths, hashes, and adapter controls together when intentionally updating
these resources; never download a moving schema during tests.
