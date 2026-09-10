/**
 * Warns when a declared security scheme is never asked for.
 *
 * `resolveSecuritySchemes` writes every `@securityScheme` into
 * `components.securitySchemes`, whether or not anything names it. That is
 * correct for the emitter: a scheme is a declaration, and declaring one is
 * true regardless of use.
 *
 * It is rarely what the author meant. `@useSecurity` puts a scheme on a
 * server, and a scheme nothing names protects nothing. The document then
 * advertises an authentication method no channel requires.
 *
 * The inverse is already reported. `undeclared-security-scheme` catches a
 * `@useSecurity` that names a scheme nobody declared, and
 * `use-security-outside-server` catches one that reaches no server. This
 * side had nothing.
 *
 * ## Not in `recommended`
 *
 * Declaring a scheme nothing names can be deliberate, not only a forgotten
 * `@useSecurity`. `components.securitySchemes` is a registry, and a document
 * may publish an authentication method before any channel requires it.
 *
 * This repository's `examples/06-servers-and-security` example does this.
 * It declares four schemes to show four kinds. It names two of them. It
 * comments one of the remaining schemes as kept for a legacy bridge. A rule
 * that fires on the project's own example states a preference. A
 * preference belongs behind an opt-in.
 *
 * ## Why it needs the whole program
 *
 * A scheme is declared on one namespace and used from another, and
 * `components.securitySchemes` is a document-wide registry. The walk
 * collects every use, and `exit` compares the two sets once it finishes.
 */

import {
  createRule,
  listServices,
  paramMessage,
  type Namespace,
  type Operation,
} from "@typespec/compiler";
// Not on the barrel. A record carries `nameTarget`, and only a reporter
// needs it; the barrel's `getSecuritySchemes` drops the target.
import { listSecuritySchemeDeclarations } from "../decorators/security/scheme-state.js";
import { getUsedSecuritySchemes } from "../decorators/index.js";
import { serviceOwner } from "../service-ownership.js";

export const unusedSecuritySchemeRule = createRule({
  name: "unused-security-scheme",
  severity: "warning",
  description: "Require a declared security scheme to be named by `@useSecurity`.",
  messages: {
    default: paramMessage`Security scheme '${"name"}' is declared but no \`@useSecurity\` names it, so it reaches \`components.securitySchemes\` without protecting anything. Apply \`@useSecurity("${"name"}")\` to a namespace that declares a server, or remove the scheme.`,
  },
  create: (context) => {
    // `@useSecurity` applies to a namespace or an operation, so those two
    // callbacks see every application. The per-target reader is the public
    // one, which also applies the deduplication `listUsedSecuritySchemes`
    // decides, so this rule and the server builder agree on what counts as
    // a use.
    const services = listServices(context.program);
    const used = new Map<Namespace | undefined, Set<string>>();
    const recordUse = (target: Namespace | Operation): void => {
      const owner =
        services.length <= 1 ? services[0]?.type : serviceOwner(context.program, target);
      const names = used.get(owner) ?? new Set<string>();
      for (const name of getUsedSecuritySchemes(context.program, target)) names.add(name);
      used.set(owner, names);
    };

    return {
      namespace: (namespace) => {
        recordUse(namespace);
      },
      operation: (operation) => {
        recordUse(operation);
      },
      exit: (program) => {
        for (const { namespace, record } of listSecuritySchemeDeclarations(program)) {
          const { name } = record.state;
          const owner = services.length <= 1 ? services[0]?.type : serviceOwner(program, namespace);
          if (
            owner === undefined
              ? [...used.values()].some((names) => names.has(name))
              : used.get(owner)?.has(name)
          )
            continue;

          // `nameTarget` rather than the namespace. It is where the author
          // wrote the name, which is the thing this warning is about.
          context.reportDiagnostic({
            format: { name },
            target: record.nameTarget,
          });
        }
      },
    };
  },
});
