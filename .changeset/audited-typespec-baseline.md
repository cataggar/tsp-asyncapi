---
"tsp-asyncapi": minor
"tsp-asyncapi-core": minor
"tsp-avro": minor
---

Require TypeSpec compiler `^1.16.0` and Node >=22. The protobuf preview now
supports `@typespec/protobuf` `0.86.x`; install it with the matching compiler.
The optional Avro peer moves to the pending `tsp-avro` `0.4.x` release line.
The workspace pins HTTP/OpenAPI tooling to 1.16.0 and resolves fast-uri 3.1.6.

This advances the compiler baseline past GHSA-2q42-4q24-7rgv and updates the
URI dependency past its reported advisories without suppressing audit findings.
Preserve server variables named `__proto__`, which the updated compiler now
passes through to decorators, instead of silently losing them during normalization.
AsyncAPI remains exactly 3.1.0. Versioning integration uses the matching
`@typespec/versioning` 0.86.0 release; this change does not itself add versioned
emission or claim versioned Service Bus profile conformance.
