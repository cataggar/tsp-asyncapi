import type { DiagnosticTarget, Program } from "@typespec/compiler";
import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import schema from "../schema/0.1.0.json" with { type: "json" };
import { reportDiagnostic, type DiagnosticCode } from "./lib.js";
import type { ServiceBusProfile } from "./types.js";

/** The extension version, independent of package/application versions. @public */
export const PROFILE_VERSION = "0.1.0";
/** The single generic extension key written by this library. @public */
export const EXTENSION_KEY = "x-azure-service-bus";
/** Fixed protocol locations; these fields are never application headers. @public */
export const NATIVE_PROPERTY_MAPPINGS = Object.freeze({
  MessageId: "properties/message-id",
  CorrelationId: "properties/correlation-id",
  SessionId: "properties/group-id",
  ReplyTo: "properties/reply-to",
  ReplyToSessionId: "properties/reply-to-group-id",
  Subject: "properties/subject",
  ContentType: "properties/content-type",
} as const);

const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
ajv.addSchema(schema);
const validators: Record<ServiceBusProfile["target"], ValidateFunction<ServiceBusProfile>> = {
  info: ajv.compile({ $ref: `${schema.$id}#/definitions/info` }),
  channel: ajv.compile({ $ref: `${schema.$id}#/definitions/channel` }),
  message: ajv.compile({ $ref: `${schema.$id}#/definitions/message` }),
  operation: ajv.compile({ $ref: `${schema.$id}#/definitions/operation` }),
};

function errorCode(error: ErrorObject): DiagnosticCode {
  const path = error.instancePath;
  if (path === "/target") return "profile-placement";
  if (/^\/deploymentRequirements\/(?:partitioning|duplicateDetection\/scope)$/u.test(path))
    return "profile-unsupported";
  if (path.startsWith("/nativeProperties")) {
    return ["type", "minLength", "maxLength", "minimum", "maximum"].includes(error.keyword)
      ? "profile-shape"
      : "native-metadata";
  }
  if (error.keyword === "additionalProperties") return "profile-shape";
  if (/^\/(applicationObligations|deliveryRequirements)/u.test(path)) return "delivery-conflict";
  if (path === "" && error.schemaPath.includes("/allOf/")) return "delivery-conflict";
  if (path.startsWith("/deploymentRequirements")) return "deployment-incompatible";
  return "profile-shape";
}

export function checkProfile(
  program: Program,
  source: DiagnosticTarget,
  target: ServiceBusProfile["target"],
  value: unknown,
): ServiceBusProfile | undefined {
  const validate = validators[target];
  if (!validate(value)) {
    const errors = validate.errors;
    if (!errors?.length) throw new Error("Profile schema validation failed without diagnostics.");
    // Conditional failures explain themselves at their field, not at each enclosing "if".
    const concrete = errors.filter((error) => error.keyword !== "if");
    for (const error of concrete) {
      reportDiagnostic(program, {
        code: errorCode(error),
        target: source,
        format: {
          detail: `${error.instancePath || "/"} ${error.message ?? "is invalid"} (${JSON.stringify(error.params)}).`,
        },
      });
    }
    return undefined;
  }
  return structuredClone(value);
}
