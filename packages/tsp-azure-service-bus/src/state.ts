import type { DecoratorContext, DiagnosticTarget, Program, Type } from "@typespec/compiler";
import { useStateMap } from "@typespec/compiler/utils";
import { $lib, reportDiagnostic, type DiagnosticCode } from "./lib.js";
import type { ServiceBusProfile } from "./types.js";

interface ProfileRecord {
  readonly profile: ServiceBusProfile;
  readonly source: DiagnosticTarget;
  readonly application?: DecoratorContext["decoratorTarget"];
}

const [read, write, records] = useStateMap<Type, ProfileRecord>($lib.createStateSymbol("profiles"));
const [reportedFor, setReported] = useStateMap<Type, Set<string>>(
  $lib.createStateSymbol("reported"),
);

export { read, write, records };

export function problem(
  program: Program,
  target: Type,
  code: DiagnosticCode,
  detail: string,
): void {
  const reported = reportedFor(program, target) ?? new Set<string>();
  const key = `${code}:${detail}`;
  if (reported.has(key)) return;
  reported.add(key);
  setReported(program, target, reported);
  reportDiagnostic(program, {
    code,
    target: read(program, target)?.source ?? target,
    format: { detail },
  });
}

/** Reads an isolated copy of a structurally validated profile; not proof of deployment. @public */
export function getProfile(program: Program, target: Type): ServiceBusProfile | undefined {
  const record = read(program, target);
  return record === undefined ? undefined : structuredClone(record.profile);
}
