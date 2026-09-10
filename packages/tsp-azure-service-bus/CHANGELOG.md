# tsp-azure-service-bus

## Unreleased

- Initial TypeSpec library for the `x-azure-service-bus` profile `0.1.0`; this
  package is not an emitter, Azure SDK, runtime, or provisioning tool.
- Four composite profile decorators, readonly public TypeScript shapes, a
  library-only testing helper, and bilingual documentation.
- Closed schema validation and source-level consistency checks; separate,
  unversioned single-service entrypoints only. Runtime/deployment obligations
  remain external.

The initial manifest version is unpublished. Release with the core minor that
adds the public extension writer, updating the workspace core dependency before
publication. Installed core `0.4.2` does not contain that API. Package versions and
profile versions are independent.
