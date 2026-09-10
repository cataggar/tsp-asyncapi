import { DiagnosticTarget, Namespace, Program } from "@typespec/compiler";
import { useStateMap } from "@typespec/compiler/utils";
import type { SecuritySchemeObject } from "../../types/index.js";
import { bySourcePosition, SourcePosition } from "../../source-order.js";

const securitySchemeStateKey = Symbol.for("tsp-asyncapi.securityScheme");

/**
 * One security scheme declared by `@securityScheme`.
 * The name is its key in `components.securitySchemes`. This is the
 * element type `getSecuritySchemes` returns.
 * @public
 */
export interface AsyncAPISecuritySchemeState {
  /** The key this scheme takes in `components.securitySchemes`. */
  name: string;
  /** The scheme itself, ready to emit. */
  scheme: SecuritySchemeObject;
}

/**
 * One `@securityScheme` application, with the source position it was
 * written at. The position orders the schemes and picks the winner of a
 * name clash.
 */
export interface SecuritySchemeRecord extends SourcePosition {
  state: AsyncAPISecuritySchemeState;
  /** Where to report a problem about the name of this application. */
  nameTarget: DiagnosticTarget;
}

const [getSecuritySchemesInternal, setSecuritySchemes, getSecuritySchemeStateMap] = useStateMap<
  Namespace,
  SecuritySchemeRecord[]
>(securitySchemeStateKey);

export { getSecuritySchemesInternal, setSecuritySchemes };

/**
 * Lists every security scheme the program declares, in source order.
 * The list is empty when the program declares none.
 *
 * @param program - The program to read the state from
 *
 * @returns The declared schemes. The list is empty when the program declares
 * none.
 */
export function listSecuritySchemes(program: Program): AsyncAPISecuritySchemeState[] {
  return listSecuritySchemeRecords(program).map((record) => record.state);
}

/**
 * Lists every declared scheme with the target a problem about it is reported
 * on, in source order.
 *
 * The resolver needs the target as well as the scheme. Everything else only
 * needs the scheme, so `listSecuritySchemes` drops it. The list is empty
 * when the program declares none.
 *
 * @param program - The program to read the state from
 *
 * @returns The records. The list is empty when the program declares none.
 *
 * @internal
 */
export function listSecuritySchemeRecords(program: Program): SecuritySchemeRecord[] {
  return listSecuritySchemeDeclarations(program).map(({ record }) => record);
}

/** Source declarations with their owning namespace; cloned replays do not duplicate source validation. */
export function listSecuritySchemeDeclarations(
  program: Program,
): { namespace: Namespace; record: SecuritySchemeRecord }[] {
  const declarations: { namespace: Namespace; record: SecuritySchemeRecord }[] = [];
  const seen = new Set<string>();
  for (const [namespace, namespaceRecords] of getSecuritySchemeStateMap(program)) {
    for (const record of namespaceRecords) {
      const key = JSON.stringify([record.file, record.pos, record.state.name]);
      if (seen.has(key)) continue;
      seen.add(key);
      declarations.push({ namespace, record });
    }
  }
  const compare = bySourcePosition(program);
  return declarations.sort((a, b) => compare(a.record, b.record));
}

/** Names declared on one live namespace, without global discovery. @internal */
export function getSecuritySchemeNames(program: Program, namespace: Namespace): readonly string[] {
  return [
    ...new Set(
      (getSecuritySchemesInternal(program, namespace) ?? []).map(({ state }) => state.name),
    ),
  ];
}
