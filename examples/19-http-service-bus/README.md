# HTTP and Service Bus: one Order, distinct envelopes

[繁體中文](./README.zh-TW.md) · [Full guide](../../docs/guide/http-service-bus.md)

This is a contract example, not an HTTP server, broker client, deployment, or
exactly-once processing implementation. It uses no credentials or live endpoints.

| Application       | Entrypoint             | Checked-in documents                                     |
| ----------------- | ---------------------- | -------------------------------------------------------- |
| Gateway messaging | `main.tsp`             | `asyncapi.yaml`, `asyncapi.json`                         |
| Gateway HTTP      | `http/main.tsp`        | `http/openapi.yaml`, `http/openapi.json`                 |
| Processor         | `processor/main.tsp`   | `processor/asyncapi.yaml`, `processor/asyncapi.json`     |
| Fulfillment       | `fulfillment/main.tsp` | `fulfillment/asyncapi.yaml`, `fulfillment/asyncapi.json` |

Each entrypoint has exactly one service. Shared message modules are imported
individually, not through an import-all barrel. `domain/order.tsp` has no transport
annotations. Messages wrap its Order; the HTTP request uses Order directly.
`environments/public.tsp` holds only inert composition placeholders and the
external authentication requirement. It does not provision or discover anything.

## Reproduce

Run from the repository root with Node **24** and pnpm **11.21.0**:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm examples:interop
pnpm examples:interop:check
pnpm exec vitest run test/integration/http-service-bus-example.test.ts test/integration/http-service-bus-payloads.test.ts
git --no-pager diff -- examples/19-http-service-bus
```

The approved final baseline is compiler/HTTP/OpenAPI/OpenAPI3 **1.16.0**, with
Protobuf/versioning **0.86.0** where used by the workspace. Use the lockfile and
workspace packages containing the companion API, not unpublished-version guesses.
The complete example emits OpenAPI **3.1.0**, AsyncAPI **3.1.0**, and the Service Bus
profile **0.1.0**; those are not TypeSpec or application versions.

**Draft integration note:** this stacked branch currently generates with the
1.15.0/0.85.0 authoring baseline. Rebase onto the approved toolchain and companion,
regenerate, and independently review before merging. Remove this note only after
that verification; the commands above use the actual frozen checkout.

To compile one application, run `pnpm exec tsp compile examples/19-http-service-bus`
or append `/http`, `/processor`, or `/fulfillment`. Individual messaging configs
default to YAML; the generator compiles every config and both formats.

The generator captures compiler writes in memory, requires exactly eight files,
and checks their original bytes without modifying them in check mode. CI executes
this check through the existing Vitest suite. Each messaging compilation must
report exactly the known `deployment-unverified` warning; other diagnostics fail.
No warning is suppressed or presented as deployment evidence.

`fixtures/flow.json` shows HTTP, message payloads, native properties, and separate
application headers. `fixtures/invalid-orders.json` contains one-fault negatives.
The tests use distinct Draft-07 and OpenAPI/2020-12 validators for the selected
native JSON subset; this is not a universal dialect or compatibility proof.
