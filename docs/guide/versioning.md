---
title: Versioned contracts
description: Emit one AsyncAPI contract per TypeSpec root version, using its resolved dependency versions.
---

# Versioned contracts

Use Node.js **22 or newer** (validated with Node.js 24), `@typespec/compiler`
**1.16.0**, and `@typespec/versioning` **0.86.0**. The emitter pins versioning
0.86.0; explicitly install the same version when importing it in your application.
This integration uses the compiler's experimental mutation API, isolated in an
adapter. A compiler/versioning upgrade needs compatibility testing.

```bash
pnpm add --save-exact @typespec/compiler@1.16.0 @typespec/versioning@0.86.0
```

```typespec
import "tsp-asyncapi";
import "@typespec/versioning";

using AsyncAPI;
using TypeSpec.Versioning;

@service
@versioned(Versions)
namespace App {
  enum Versions { v1: "1.0", v2: "2.0" }

  @message model Event {
    @removed(Versions.v2) legacy: string;
    @added(Versions.v2) replacement: string;
  }

  @channel("events") interface Events {
    @send op publish(event: Event): void;
  }
}
```

With `emit: ["tsp-asyncapi"]`, the emitter writes:

| Output              | `info.version` | Payload properties and `required` |
| ------------------- | -------------- | --------------------------------- |
| `asyncapi.1.0.yaml` | `1.0`          | `legacy` only                     |
| `asyncapi.2.0.yaml` | `2.0`          | `replacement` only                |

It emits **all declared root versions by default**. Each document has fresh
declaration discovery, header planning, component keys, schema artifacts and
reference caches. The original Program and source types remain available to other
emitters; the AsyncAPI views contain different live type identities.

## Selecting a version

```yaml
emit:
  - tsp-asyncapi
options:
  tsp-asyncapi:
    version: "2.0"
    file-type: json
    output-file: "contracts/{version}/asyncapi.{file-type}"
```

`version` matches the enum **value**, not the member name: `"2.0"`, not `"v2"`.
Selection requires exactly one selected versioned service. Unknown versions,
unversioned services (including dependency-only views), and ambiguous services
are errors. Selecting one version does not remove its suffix from default
filenames.

The selected root version always supplies `info.version`. An authored
`@info(#{ version: "..." })` never selects schemas. A differing value raises the
nonfatal `version-info-conflict` warning and is replaced by the selected value.
Unversioned documents retain their authored metadata or existing defaults.

Output templates accept `{service-name}`, `{service-name-if-multiple}`,
`{version}`, and `{file-type}`. A literal custom filename is permitted when it is
unique; it cannot overwrite multiple versions. All filenames are checked before
any output is written, including portable normalized collisions.

## Service selection and aliases

With multiple services, each selected original service gets its own version
views. Use `service: Apps.Versioned` together with `version: "2.0"` to select one.
The default filename remains `asyncapi.Apps.Versioned.2.0.yaml` even when filtering
leaves one document; both the service identity and original service count are
captured before mutation. Unversioned and dependency-only services omit the
version filename token. HTTP-only services receive their own empty AsyncAPI
document instead of another application's messaging declarations.

Service ownership is applied **after** mutation. A declaration removed from the
selected version cannot return through original decorator registries or an
operation's source-signature provenance. Used or unused instantiated message,
interface-channel, and action aliases are inventoried before mutation, inserted
into cloned namespace maps before TypeSpec applies availability changes, and
then traversed as real versioned types. Their properties, operation signatures,
and removal behavior follow the selected view; source declarations stay unchanged.
Distinct instances keep separate inventory keys even when their shared declaration
is renamed. Normal channel/operation naming collisions are still diagnosed.

Decorator replay diagnostics from an excluded service do not invalidate the
selected service. Diagnostics from domain types actually referenced by the
selected view, including headers and historical property types, remain errors.
The adapter scopes only synchronous mutation-time replay; original compilation
diagnostics are preserved.

## Dependencies and supported changes

Declare dependency choices with TypeSpec `@useDependency`, on root enum members
or an unversioned service namespace. The versioning library resolves the chosen
versions, including transitive dependencies. The emitter does not select the
latest dependency, or emit a Cartesian product of dependency versions.
A dependency-only service gets one transient view, keeps its own `info.version`,
and retains the unversioned default filename.

Supported typed changes include `@added`, `@removed`, `@renamedFrom`,
`@madeOptional`, `@madeRequired`, `@typeChangedFrom`, and
`@returnTypeChangedFrom`. They apply before schema/message discovery, interface
channel and operation resolution, header separation, and channel parameter
resolution. Recursive/shared references stay within the selected document.
Generated Avro and Protobuf previews read that same effective graph, subject to
their existing supported-feature restrictions.

## Limits and refusals

- TypeSpec validates decorator targets. For example, version a channel
  **interface**, not a namespace with `@added` (an unsupported target).
  A `@headers` decorator cannot refer to a removed model in a selected view;
  such references are refused instead of importing the removed declaration.
- Versioned messaging declarations need a selected versioned `@service` or a
  service with `@useDependency`. The no-service fallback cannot infer a version
  from an arbitrary nested `@versioned` namespace and refuses that combination.
- Literal addresses, explicit `@message` names, runtime expressions, extension
  strings, and raw schemas are authored values, not TypeSpec declarations. They
  are not renamed or rewritten automatically. A renamed channel parameter can
  invalidate an unchanged address; that selected view is diagnosed.
- Raw schema local references are checked against each output. A raw payload
  replaces its carrier's typed body: combining it with versioned body fields is
  refused rather than claiming the raw schema followed those changes. Use
  separate version-available empty message carriers with separate raw schemas.
  Static raw schemas are passed through, not validated for wire compatibility.
- Unsupported generated-schema combinations, conflicting providers, and errors
  found while resolving/lowering any selected root-version or dependency-only
  view prevent the **entire output set** from being written. Malformed schema
  extensions also refuse the whole set, including unversioned service outputs.
  A refused binary view is not lowered as native; other selected views are still
  validated. `noEmit` writes no files; compiler 1.16 skips emitter execution, so
  emitter-specific view validation requires an emission pass.
- Native schemas support instantiated message aliases. The Avro and Protobuf
  providers still reject template-instance payloads; these aliases are explicitly
  diagnosed rather than dropped or silently emitted as native schemas.
- Version-correct schemas are not a producer/consumer compatibility guarantee.
  Retained messages need separate old/new validation and transport-specific
  reader/writer tests. The standalone Avro emitter still describes the original
  source; only AsyncAPI's preview payloads select these versioned views.
