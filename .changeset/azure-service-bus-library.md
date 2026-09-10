---
"tsp-azure-service-bus": minor
---

Add the initial `tsp-azure-service-bus` TypeSpec library for the closed
`x-azure-service-bus` profile `0.1.0`, including four composite decorators,
readonly public profile types, schema-backed/source validation, testing support,
and English/Traditional Chinese references.

Release together with the core minor introducing the public generic extension
writer and binding inspection. The companion's `workspace:^` core peer and
development dependency must resolve to that release before publication; existing
core `0.4.2` does not provide the writer. The initial manifest version is
unpublished, and profile versions are independent of package release versions.
