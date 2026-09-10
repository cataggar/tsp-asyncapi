import { createTypeSpecLibrary, paramMessage } from "@typespec/compiler";

/** The companion package and diagnostic namespace. @public */
export const PACKAGE_NAME = "tsp-azure-service-bus";

/** Registers contract diagnostics, not a runtime or emitter. @public */
export const $lib = createTypeSpecLibrary({
  name: PACKAGE_NAME,
  diagnostics: {
    "profile-shape": { severity: "error", messages: { default: paramMessage`${"detail"}` } },
    "profile-placement": { severity: "error", messages: { default: paramMessage`${"detail"}` } },
    "profile-conflict": { severity: "error", messages: { default: paramMessage`${"detail"}` } },
    "topology-conflict": { severity: "error", messages: { default: paramMessage`${"detail"}` } },
    "entity-direction": { severity: "error", messages: { default: paramMessage`${"detail"}` } },
    "transport-conflict": { severity: "error", messages: { default: paramMessage`${"detail"}` } },
    "native-metadata": { severity: "error", messages: { default: paramMessage`${"detail"}` } },
    "application-properties": {
      severity: "error",
      messages: { default: paramMessage`${"detail"}` },
    },
    "delivery-conflict": { severity: "error", messages: { default: paramMessage`${"detail"}` } },
    "deployment-incompatible": {
      severity: "error",
      messages: { default: paramMessage`${"detail"}` },
    },
    "profile-unsupported": { severity: "error", messages: { default: paramMessage`${"detail"}` } },
    "reply-conflict": { severity: "error", messages: { default: paramMessage`${"detail"}` } },
    "runtime-location": { severity: "error", messages: { default: paramMessage`${"detail"}` } },
    "deployment-unverified": {
      severity: "warning",
      messages: { default: paramMessage`${"detail"}` },
    },
  },
});

export const reportDiagnostic: typeof $lib.reportDiagnostic = (program, diagnostic) => {
  $lib.reportDiagnostic(program, diagnostic);
};
export type DiagnosticCode = keyof typeof $lib.diagnostics;
