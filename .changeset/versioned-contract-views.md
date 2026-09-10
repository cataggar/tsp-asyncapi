---
"tsp-asyncapi": minor
"tsp-asyncapi-core": minor
"tsp-avro": patch
---

Emit AsyncAPI contracts from TypeSpec root/dependency version views using compiler
1.16 and versioning 0.86. Support exact version-value selection, per-version
metadata and filenames, collision preflight, effective native/header/Avro/Protobuf
schemas, and explicit refusals for unsupported versioned contracts. Require Node
22 or newer and document the experimental adapter and raw-schema limitations.

Combine service selection with versioning through complete effective declaration
boundaries, including truly mutated alias-only messages, channels, and actions.
Apply service ownership after mutation and preflight the shared output plan.
Withhold the whole selected set for malformed schema extensions. Skip native
fallback lowering after a binary refusal while validating other selected views.

Keep standalone Avro record discovery on original declarations, including erased
alias instances, when another emitter has replayed decorators on versioned clones.
