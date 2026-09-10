---
"tsp-asyncapi": patch
"tsp-asyncapi-core": patch
"tsp-avro": patch
---

Diagnose unmapped native scalars, unsupported encoded constraints, later-draft
schema extensions and authored validation overrides. Reject malformed known
extension values and withhold document output on that error. Compare enum values
structurally, inspect schema dependencies, and warn when an authored reference
displaces generated assertions. Rewrite encoded scalar intersections and nullable
unions without leaving contradictory wire types or meaningless constraints.

Refuse generated Avro/Protobuf transformations that would silently lose supported
compiler metadata, inherited/indexed fields or explicit protobuf defaults. Keep
Avro default field names independent from JSON encoded names, validate nested
defaults against the emitted first union branches, and refuse logical types
outside the advertised Avro 1.9 dialect. Check explicit Protobuf metadata across
the complete scalar ancestry without changing supported wire mappings.

Add nonmutating emitted payload/header validators, independently compiled
bidirectional producer/consumer fixtures and bilingual capability/limitation
documentation. Enforce draft-07 reference semantics, keep opaque annotations out
of identifier registries, and distinguish absent headers from explicit null.
Version-generated retained-message fixtures remain separate.
