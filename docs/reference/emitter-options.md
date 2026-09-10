---
title: "Emitter Options"
description: 'Set these in `tspconfig.yaml`, or pass them on the CLI with `--option "tsp-asyncapi.<name>=<value>"`.'
---

# Emitter Options

Set these in `tspconfig.yaml`, or pass them on the CLI with `--option "tsp-asyncapi.<name>=<value>"`.

| Option                 | Type               | Default                                                     | Effect                                                                                                      |
| ---------------------- | ------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `file-type`            | `"yaml" \| "json"` | `yaml`                                                      | Serialization format of the document.                                                                       |
| `output-file`          | `string`           | `asyncapi.{service-name-if-multiple}.{version}.{file-type}` | Filename or template, written under `tsp-output/tsp-asyncapi/`.                                             |
| `service`              | `string`           | (all declared services)                                     | Select one exact fully qualified service namespace, such as `Company.Orders`.                               |
| `asyncapi-id`          | `string`           | (omitted)                                                   | Emitted as the document's top-level `id` field — the application's global identifier, conventionally a URN. |
| `default-content-type` | `string`           | (omitted)                                                   | Emitted as `defaultContentType` — the content type message payloads use when a message declares none.       |
| `preview-features`     | `string[]`         | `[]`                                                        | Turns on preview features. The reserved names are `protobuf` and `avro`.                                    |

Options the schema declares but you don't set are omitted from the document entirely, not emitted as empty values.

## Via `tspconfig.yaml`

```yaml
emit:
  - "tsp-asyncapi"
options:
  "tsp-asyncapi":
    output-file: "orders.yaml"
    file-type: "yaml"
    asyncapi-id: "urn:com:example:orders"
    default-content-type: "application/json"
```

## Via the CLI

```bash
tsp compile . --emit tsp-asyncapi \
  --option "tsp-asyncapi.file-type=json" \
  --option "tsp-asyncapi.asyncapi-id=urn:com:example:orders"
```

An unknown option name fails validation (`additionalProperties: false`), so a typo is caught at compile time rather than silently ignored. A name in `preview-features` that is not reserved fails the same way, and the message lists the names that are.

## Service documents and filenames

By default, every namespace marked `@service` produces its own AsyncAPI document. This includes HTTP-only services: a service without messaging declarations produces an empty AsyncAPI document, rather than being guessed from HTTP decorators. No HTTP library is required.

`service` matches the namespace's exact, case-sensitive fully qualified name, not its title or short name. An unknown or ambiguous selector is an error. Selecting `Company.Orders` from a program with several services still writes `asyncapi.Company.Orders.yaml`; filtering never changes the original service count used for naming.

| Token                        | Value                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{service-name}`             | Original fully qualified service namespace; omitted for the no-service fallback.                                                                         |
| `{service-name-if-multiple}` | The same name, only when the original program declares more than one service.                                                                            |
| `{version}`                  | Optional version identity supplied by a version-aware adapter; omitted for unversioned documents. This option alone does not enable TypeSpec versioning. |
| `{file-type}`                | `yaml` or `json`.                                                                                                                                        |

An omitted token also removes its following `.` or `/`. Thus the default remains `asyncapi.yaml` or `asyncapi.json` with zero or one unversioned service. A template such as `{service-name}/asyncapi.{file-type}` creates a service subdirectory. Service/version values are escaped as portable path segments: UTF-8 percent encoding preserves punctuation and Unicode without allowing path separators, reserved device names, or trailing dots to change the destination.

A literal `output-file: orders.yaml` remains valid for one selected document. For several documents, include distinguishing tokens. All paths are resolved and checked together, including case-insensitive collisions. Unknown tokens, invalid filenames, and collisions are errors; the emitter does not overwrite one document with another or append counters.

## Ownership and reusable contracts

A declaration belongs to its nearest enclosing `@service`. Nested services are separate boundaries, even when their namespaces are reopened elsewhere. Channels, actions, messages, replies, servers, security schemes, bindings, tags, extensions, and document diagnostics are resolved inside that boundary before assigning component keys.

Owned `@message` models are retained even when unused. A messaging signature may explicitly use an unowned reusable `@message`; unreferenced unowned messages stay out when there are multiple services. Ordinary domain models may be shared through payloads and headers, including models declared under another service, without importing that service's application metadata. A foreign service's `@message` envelope or reply channel is an error: wrap shared domain data in a local envelope instead. This includes foreign envelopes reached through discriminator-derived subtypes; ordinary undecorated shared subtypes remain valid.

With one original service, otherwise unowned declarations keep their legacy implicit ownership. With no services, the legacy global fallback document remains. With multiple original services, unowned channels and actions are ambiguous, even if `service` selects just one app. Move application declarations beneath their owner. Unowned inherited/template operation signatures that are realized on an owned channel are reusable carriers, not additional application roots.

The emitter resolves all selected documents before writing any of them. New selection/ownership errors, output collisions, ambiguous visible security definitions, and provider refusals withhold the whole output set. Existing resolve/lower diagnostic-and-drop behavior remains unchanged. `noEmit` suppresses writes, not diagnostics. Source validation still applies to the entire TypeSpec program; selecting a service does not hide source errors in another service.

Changed-graph adapters must supply a complete live declaration boundary, including retained alias-only messages, channels, and actions. Namespace-map discovery alone cannot prove that boundary complete. Missing or stale inputs report `incomplete-effective-document` or `stale-effective-declaration` and refuse the context. Original/source models are diagnostics or inventory inputs, not substitutes for live declarations or artifacts. An explicitly identical original graph retains the ordinary alias behavior.

## Preview features

A preview feature changes the emitted document. Two names are reserved: `protobuf` and `avro`. Both work in this release. A name with no provider behind it reports `preview-feature-unavailable`, and no file is written. A request that names one working feature and one unavailable one is refused the same way, because the request as a whole cannot be answered.

`protobuf` gives a model that carries the official `TypeSpec.Protobuf` decorators a proto3 payload. The [Protobuf payloads guide](../guide/protobuf-payloads) shows what it writes.

`avro` gives a model that carries the `tsp-avro` `@Avro.avroRecord` decorator an Avro payload. The payload is written as an object, because Avro is JSON. `tsp-avro` is an optional peer dependency of the emitter. Install it in the project that turns this feature on.

Both features can be on at once. One model may carry only one of the two sets of decorators. A model that carries both is reported as `conflicting-generated-schema-source`, and no file is written.

::: warning
Nothing is emitted when a preview feature is refused. A document written next to the error would ignore the request without saying so.
:::
