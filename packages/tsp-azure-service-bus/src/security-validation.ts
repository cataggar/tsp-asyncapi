import { listServices, type Namespace, type Operation, type Program } from "@typespec/compiler";
import { getSecuritySchemes, getServers, getUsedSecuritySchemes } from "tsp-asyncapi-core";
import { problem } from "./state.js";

export function validateSecurity(
  program: Program,
  target: Namespace | Operation,
  authentication?: "entraId" | "sas",
): void {
  const names = new Set(getUsedSecuritySchemes(program, target));
  const service = listServices(program)[0].type;
  if (target.kind === "Operation" && getServers(program, service).length > 0) {
    getUsedSecuritySchemes(program, service).forEach((name) => names.add(name));
  }
  const schemes = new Map(getSecuritySchemes(program).map(({ name, scheme }) => [name, scheme]));
  for (const name of names) {
    const scheme = schemes.get(name);
    if (!scheme) {
      problem(program, target, "transport-conflict", `Security scheme '${name}' is not declared.`);
      continue;
    }
    const plain = scheme.type === "plain";
    const oauth =
      scheme.type === "oauth2" &&
      scheme.flows?.clientCredentials !== undefined &&
      Object.keys(scheme.flows).length === 1;
    if (!plain && !oauth) {
      problem(
        program,
        target,
        "profile-unsupported",
        `Security scheme '${name}' is not SASL PLAIN or an actual OAuth2 client-credentials description. HTTP bearer/API-key schemes do not describe native AMQP CBS.`,
      );
    } else if ((authentication === "entraId" && plain) || (authentication === "sas" && oauth)) {
      problem(
        program,
        target,
        "transport-conflict",
        `Security scheme '${name}' contradicts the declared '${authentication}' authentication requirement.`,
      );
    }
  }
}
