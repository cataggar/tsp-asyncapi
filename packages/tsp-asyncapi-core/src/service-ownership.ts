import { getService, type Namespace, type Program, type Type } from "@typespec/compiler";

/** The nearest service boundary, independently of direct channel ownership. @internal */
export function serviceOwner(program: Program, type: Type): Namespace | undefined {
  if (type.kind === "ModelProperty") {
    return type.model === undefined ? undefined : serviceOwner(program, type.model);
  }
  if (type.kind === "EnumMember") return serviceOwner(program, type.enum);
  if (type.kind === "UnionVariant") return serviceOwner(program, type.union);
  let namespace: Namespace | undefined;
  if (type.kind === "Namespace") namespace = type;
  else if (type.kind === "Operation") namespace = type.interface?.namespace ?? type.namespace;
  else if ("namespace" in type) namespace = type.namespace;
  while (namespace !== undefined) {
    if (getService(program, namespace) !== undefined) return namespace;
    namespace = namespace.namespace;
  }
  return undefined;
}
