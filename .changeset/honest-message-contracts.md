---
"tsp-asyncapi": patch
"tsp-asyncapi-core": patch
"tsp-avro": patch
---

Diagnose unmapped native scalars, unsupported encoded constraints, later-draft
schema extensions and authored validation overrides. Reject malformed known
extension values and withhold document output on that error. Rewrite encoded scalar intersections without leaving
contradictory wire types or meaningless constraints.

Refuse generated Avro/Protobuf transformations that would silently lose supported
compiler metadata, inherited/indexed fields or explicit protobuf defaults. Keep
Avro default field names independent from JSON encoded names and refuse logical
types outside the advertised Avro 1.9 dialect.

Add nonmutating emitted payload/header validators, independently compiled
bidirectional producer/consumer fixtures and bilingual capability/limitation
documentation. Version-generated retained-message fixtures remain separate.
