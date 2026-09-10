import { listServices, type Namespace, type Operation, type Program } from "@typespec/compiler";
import {
  getSecuritySchemes,
  getServers,
  getUsedSecuritySchemes,
  type AsyncAPISecuritySchemeState,
} from "tsp-asyncapi-core";
import { problem } from "./state.js";

type Authentication = "entraId" | "sas";

function supportedAuthentication(
  scheme: AsyncAPISecuritySchemeState["scheme"],
): Authentication | undefined {
  if (scheme.type === "plain") return "sas";
  if (
    scheme.type === "oauth2" &&
    scheme.flows?.clientCredentials !== undefined &&
    Object.keys(scheme.flows).length === 1
  )
    return "entraId";
  return undefined;
}

function validateSecurityGroup(
  program: Program,
  target: Namespace | Operation,
  owner: Namespace | Operation,
  authentication?: Authentication,
): void {
  const names = getUsedSecuritySchemes(program, owner);
  if (names.length === 0) return;
  const schemes = new Map(getSecuritySchemes(program).map(({ name, scheme }) => [name, scheme]));
  const supported = new Set<Authentication>();
  let declared = false;
  for (const name of names) {
    const scheme = schemes.get(name);
    if (scheme === undefined) {
      problem(program, owner, "transport-conflict", `Security scheme '${name}' is not declared.`);
      continue;
    }
    declared = true;
    const method = supportedAuthentication(scheme);
    if (method !== undefined) supported.add(method);
  }
  const group = `${owner.kind === "Namespace" ? "Server" : "Operation"} security on '${owner.name}'`;
  if (declared && supported.size === 0) {
    problem(
      program,
      target,
      "profile-unsupported",
      `${group} has no supported alternative. Only SASL PLAIN or an actual OAuth2 client-credentials description can satisfy this profile; HTTP bearer/API-key schemes do not describe native AMQP CBS.`,
    );
  } else if (supported.size > 0 && authentication !== undefined && !supported.has(authentication)) {
    problem(
      program,
      target,
      "transport-conflict",
      `${group} has no alternative compatible with the declared '${authentication}' authentication requirement.`,
    );
  }
}

export function validateSecurity(
  program: Program,
  target: Namespace | Operation,
  authentication?: Authentication,
): void {
  validateSecurityGroup(program, target, target, authentication);
  const service = listServices(program)[0].type;
  if (target.kind === "Operation" && getServers(program, service).length > 0) {
    validateSecurityGroup(program, target, service, authentication);
  }
}
