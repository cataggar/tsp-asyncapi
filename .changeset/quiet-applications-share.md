---
"tsp-asyncapi": minor
"tsp-asyncapi-core": minor
---

Emit one isolated AsyncAPI document per declared service, including empty services.
Add exact fully qualified service selection and portable output filename templates
with complete collision preflight. Preserve zero/one-service legacy filenames and
implicit ownership, while rejecting ambiguous unowned multi-service applications
and foreign message/reply contracts before writing the output set.

Scope declarations, security names, artifacts, diagnostics, and metadata per
document. Separate services may reuse security scheme names; explicitly used shared
definitions must be unambiguous. Internal live-graph contexts remain compatible with
the original Program and optional effective namespace/realm adapters.

Validate discriminator-reachable message envelopes and retain aliased action
instances. Changed-graph adapters must supply complete live declaration boundaries,
including retained erased aliases and deliberate removals. Missing or stale
boundaries are diagnosed and refused instead of silently dropping contracts.
