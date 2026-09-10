import type { Type } from "@typespec/compiler";
import { unsafe_Realm as Realm } from "@typespec/compiler/experimental";

/** Compiler 1.16 adapter: alternate emitter views must not become source records. @internal */
export function isSourceType(type: Type): boolean {
  return !Realm.realmForType.has(type);
}
