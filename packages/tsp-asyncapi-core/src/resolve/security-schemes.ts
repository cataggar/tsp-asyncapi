/**
 * The resolve half of the security schemes.
 *
 * Scoped reads use live namespace identities and optional shared-name
 * selection. Standalone callers retain the legacy global registry.
 */

import { Namespace, Program } from "@typespec/compiler";
import { getSecuritySchemes } from "../decorators/security/scheme.js";
import {
  getSecuritySchemesInternal,
  listSecuritySchemeRecords,
} from "../decorators/security/scheme-state.js";
import { bySourcePosition } from "../source-order.js";
import { reportDiagnostic } from "../lib.js";
import { SecuritySchemeNode } from "./service.js";

/**
 * Resolves the document's security scheme registry.
 *
 * The decorator already checked each scheme. It reported a diagnostic and
 * dropped schemes with a bad name, a blank required field, or unusable OAuth
 * flows. Source validation checks owned duplicates; this boundary diagnoses
 * ambiguity introduced by visible shared definitions.
 *
 * @param program - The program to read the schemes from
 *
 * @returns The schemes, in source order
 *
 * @internal
 */
export function resolveSecuritySchemes(
  program: Program,
  namespaces?: readonly Namespace[],
  names?: ReadonlyMap<Namespace, ReadonlySet<string>>,
): readonly SecuritySchemeNode[] {
  const claimed = new Set<string>();
  if (namespaces !== undefined) {
    return namespaces
      .flatMap((namespace) =>
        (getSecuritySchemesInternal(program, namespace) ?? []).filter(
          ({ state }) => names === undefined || names.get(namespace)?.has(state.name),
        ),
      )
      .sort(bySourcePosition(program))
      .filter((record) => {
        if (claimed.has(record.state.name)) {
          reportDiagnostic(program, {
            code: "ambiguous-security-scheme",
            target: record.nameTarget,
            format: { name: record.state.name },
          });
          return false;
        }
        claimed.add(record.state.name);
        return true;
      })
      .map((record) => ({
        target: record.nameTarget,
        name: record.state.name,
        scheme: record.state.scheme,
      }));
  }
  const states = getSecuritySchemes(program);
  const records = listSecuritySchemeRecords(program);
  // Both lists come from one sorted read, so index `i` names one scheme in
  // both. The state list is the copied one, and the record list is what
  // carries the diagnostic target.
  return states
    .map((state, index) => ({
      target: records[index].nameTarget,
      name: state.name,
      scheme: state.scheme,
    }))
    .filter(({ name }) => {
      if (claimed.has(name)) return false;
      claimed.add(name);
      return true;
    });
}
