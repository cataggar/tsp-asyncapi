---
"tsp-asyncapi-core": minor
---

Expose `addExtension` and its diagnostic-target options for companion decorators, using the same validation, marshalling, placement and source-order collision rules as `@extension`. Copy extension values on write and read so callers cannot mutate recorded JSON.

Expose `getBindings` with read-only, source-ordered protocol, scope and copied config snapshots, without compiler targets or renderer internals.
