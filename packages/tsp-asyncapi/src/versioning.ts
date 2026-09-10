/**
 * Compiler 1.16 / versioning 0.86 adaptation. Keep the original Program and
 * source types; confine experimental mutation and synchronous replay hooks here.
 */
import {
  compilerAssert,
  getService,
  getNamespaceFullName,
  isTemplateInstance,
  ListenerFlow,
  navigateType,
  type Diagnostic,
  type Interface,
  type Model,
  type Namespace,
  type Operation,
  type Program,
  type Service,
  type SemanticNodeListener,
  type Type,
} from "@typespec/compiler";
import {
  unsafe_mutateSubgraphWithNamespace,
  type unsafe_MutatorWithNamespace as MutatorWithNamespace,
} from "@typespec/compiler/experimental";
import { createRekeyableMap } from "@typespec/compiler/utils";
import { getVersioningMutators, resolveVersions } from "@typespec/versioning";
import { getHeadersModel, reportDiagnostic } from "tsp-asyncapi-core";
import { discoverDocumentDeclarations, type EffectiveDocumentGraph } from "./document-context.js";
import { discriminatorSubtypes, discoverOriginalDocumentDeclarations } from "./service-context.js";
import { serviceOwner, type DocumentDeclarations } from "tsp-asyncapi-core/unstable";

/** One root version, a dependency-only view, or an unchanged service. @internal */
export interface VersionedDocumentPlan {
  readonly originalService: Service | undefined;
  readonly effective: EffectiveDocumentGraph | undefined;
  readonly version: string | undefined;
}

/**
 * Uses the library's resolved root/dependency snapshots, including transitive
 * choices. Call before discovering declarations, keys, headers or artifacts.
 * Undefined is a fatal selection failure, not an empty successful plan.
 *
 * @internal
 */
export function planVersionedDocuments(
  program: Program,
  services: readonly (Service | undefined)[],
  selector?: string,
): readonly VersionedDocumentPlan[] | undefined {
  const inventory = discoverOriginalDocumentDeclarations(program);
  const erased = erasedRoots(inventory);
  const selections = services.map((service) => ({
    service,
    root: service?.type ?? program.getGlobalNamespaceType(),
    mutations: getVersioningMutators(program, service?.type ?? program.getGlobalNamespaceType()),
    resolutions: resolveVersions(program, service?.type ?? program.getGlobalNamespaceType()),
  }));
  if (selector !== undefined) {
    const selected = selections[0];
    let reason: string | undefined;
    if (selections.length !== 1) {
      reason = "the selected service is ambiguous";
    } else if (selected.mutations?.kind !== "versioned") {
      reason = "the selected service has no declared root versions";
    } else if (
      selected.mutations.snapshots.filter((snapshot) => snapshot.version.value === selector)
        .length !== 1
    ) {
      reason = "the value is missing or identifies multiple root versions";
    }
    if (reason !== undefined) {
      reportDiagnostic(program, {
        code: "invalid-version-selection",
        target: selections.length === 1 ? selected.root : program.getGlobalNamespaceType(),
        format: { version: selector, reason },
      });
      return undefined;
    }
  }

  return selections.flatMap(
    ({ service, root, mutations, resolutions }): VersionedDocumentPlan[] => {
      if (mutations === undefined) {
        return [
          {
            originalService: service,
            effective: { root, service, declarations: inventory },
            version: undefined,
          },
        ];
      }
      const snapshots =
        mutations.kind === "transient"
          ? [{ mutator: mutations.mutator, version: undefined }]
          : mutations.snapshots.filter(
              (snapshot) => selector === undefined || snapshot.version.value === selector,
            );
      return snapshots.map(({ mutator, version }) => {
        const resolution = resolutions.find(
          (entry) => entry.rootVersion?.enumMember === version?.enumMember,
        );
        compilerAssert(
          resolution !== undefined,
          "Version mutation must have a resolved dependency choice.",
        );
        const versionChoices = new Map(
          [...resolution.versions.values()].map((chosen) => [
            getNamespaceFullName(chosen.namespace),
            chosen.value,
          ]),
        );
        const sourceModels = new Map<Model, Model>();
        const mutation = captureReplayDiagnostics(program, () =>
          unsafe_mutateSubgraphWithNamespace(
            program,
            versionMutators(mutator, erased, sourceModels),
            root,
          ),
        );
        const { type, realm } = mutation.value;
        compilerAssert(type.kind === "Namespace", "Versioning must preserve the namespace root.");
        const declarations = liveDeclarations(type, inventory, erased);
        reportReplayDiagnostics(program, type, declarations, mutation.diagnostics);
        return {
          originalService: service,
          version: version?.value,
          effective: {
            root: type,
            service: service === undefined ? undefined : getService(program, type),
            realm: realm ?? undefined,
            version: version?.value,
            sourceModels,
            versionChoices,
            declarations,
          },
        };
      });
    },
  );
}

interface ErasedRoots {
  readonly models: Model[];
  readonly interfaces: Interface[];
  readonly operations: Operation[];
}

function versionMutators(
  mutator: MutatorWithNamespace,
  erased: ReadonlyMap<Namespace, ErasedRoots>,
  sourceModels: Map<Model, Model>,
): MutatorWithNamespace[] {
  return [
    {
      name: "AsyncAPI erased declaration roots",
      Namespace(source, clone) {
        const aliases = erased.get(source);
        if (aliases === undefined) return;
        clone.models = insertRoots(clone.models, aliases.models);
        clone.interfaces = insertRoots(clone.interfaces, aliases.interfaces);
        clone.operations = insertRoots(clone.operations, aliases.operations);
      },
    },
    mutator,
    {
      name: "AsyncAPI version provenance",
      Model(source, clone) {
        sourceModels.set(clone, source);
      },
    },
  ];
}

function erasedRoots(inventory: DocumentDeclarations): ReadonlyMap<Namespace, ErasedRoots> {
  const roots = new Map<Namespace, ErasedRoots>();
  const provenance = operationProvenance(inventory.operations);
  const group = (namespace: Namespace) => {
    let known = roots.get(namespace);
    if (known === undefined) {
      known = { models: [], interfaces: [], operations: [] };
      roots.set(namespace, known);
    }
    return known;
  };
  for (const model of inventory.models) {
    if (
      model.namespace !== undefined &&
      model.isFinished &&
      isTemplateInstance(model) &&
      ![...model.namespace.models.values()].includes(model)
    )
      group(model.namespace).models.push(model);
  }
  for (const channel of inventory.channels) {
    if (
      channel.kind === "Interface" &&
      channel.namespace !== undefined &&
      channel.isFinished &&
      ![...channel.namespace.interfaces.values()].includes(channel)
    ) {
      group(channel.namespace).interfaces.push(channel);
    }
  }
  for (const operation of inventory.operations) {
    if (
      !provenance.has(operation) &&
      operation.interface === undefined &&
      operation.namespace !== undefined &&
      operation.isFinished &&
      ![...operation.namespace.operations.values()].includes(operation)
    ) {
      group(operation.namespace).operations.push(operation);
    }
  }
  return roots;
}

function insertRoots<T>(map: Map<string, T>, roots: readonly T[]): Map<string, T> {
  if (roots.length === 0) return map;
  const retained = createRekeyableMap(map);
  const instanceKeys = new Set<string>();
  let index = 0;
  for (const root of roots) {
    while (retained.has(`__asyncapi_version_instance_${String(index)}`)) index++;
    const key = `__asyncapi_version_instance_${String(index++)}`;
    instanceKeys.add(key);
    retained.set(key, root);
  }
  // The compiler rekeys renamed children by their declaration name. Multiple
  // instances share that name; only their synthetic inventory keys must stay put.
  const rekey = retained.rekey.bind(retained);
  retained.rekey = (key, name) => {
    return instanceKeys.has(key) ? retained.has(key) : rekey(key, name);
  };
  return retained;
}

interface ReplayDiagnostic {
  readonly diagnostic: Diagnostic;
  readonly type: Type;
}

function captureReplayDiagnostics<T>(
  program: Program,
  mutate: () => T,
): { value: T; diagnostics: readonly ReplayDiagnostic[] } {
  const diagnostics: ReplayDiagnostic[] = [];
  const hooks = (
    [
      [program, "reportDiagnostic"],
      [program, "reportDiagnostics"],
      [program.checker, "finishType"],
    ] as const
  ).map(([target, key]) => ({
    target,
    key,
    descriptor: Object.getOwnPropertyDescriptor(target, key),
  }));
  const report = program.reportDiagnostic.bind(program);
  const finish = program.checker.finishType.bind(program.checker);
  let finishing: Type | undefined;
  // Namespace mutation visits excluded services too. Associate replay reports
  // with the exact finished instance, not its potentially shared source node.
  try {
    program.reportDiagnostic = (diagnostic) => {
      if (finishing === undefined) report(diagnostic);
      else diagnostics.push({ diagnostic, type: finishing });
    };
    program.reportDiagnostics = (reports) => {
      for (const diagnostic of reports) program.reportDiagnostic(diagnostic);
    };
    program.checker.finishType = (type) => {
      const previous = finishing;
      finishing = type;
      try {
        return finish(type);
      } finally {
        finishing = previous;
      }
    };
    return { value: mutate(), diagnostics };
  } finally {
    for (const { target, key, descriptor } of hooks) {
      if (descriptor === undefined) Reflect.deleteProperty(target, key);
      else Object.defineProperty(target, key, descriptor);
    }
  }
}

function reportReplayDiagnostics(
  program: Program,
  root: Namespace,
  declarations: DocumentDeclarations,
  diagnostics: readonly ReplayDiagnostic[],
): void {
  if (diagnostics.length === 0) return;
  const active = activeContractTypes(program, root, declarations);
  for (const { diagnostic, type } of diagnostics) {
    const owner = serviceOwner(program, type);
    if (owner === undefined || owner === root || active.has(type)) {
      program.reportDiagnostic(diagnostic);
    }
  }
}

function activeContractTypes(
  program: Program,
  root: Namespace,
  declarations: DocumentDeclarations,
): ReadonlySet<Type> {
  const active = new Set<Type>();
  const pending = [...declarations.diagnosticTargets].filter(
    (type) => serviceOwner(program, type) === root,
  );
  const add = (type: Type): ListenerFlow | undefined => {
    if (active.has(type)) return ListenerFlow.NoRecursion;
    active.add(type);
    return undefined;
  };
  const listeners: SemanticNodeListener = {
    namespace: () => ListenerFlow.NoRecursion,
    model(model) {
      if (add(model) === ListenerFlow.NoRecursion) return ListenerFlow.NoRecursion;
      const headers = getHeadersModel(program, model);
      if (headers !== undefined) pending.push(headers);
      pending.push(...discriminatorSubtypes(program, model));
      return undefined;
    },
    operation(operation) {
      if (add(operation) !== ListenerFlow.NoRecursion) {
        pending.push(...operation.parameters.properties.values(), operation.returnType);
      }
      return ListenerFlow.NoRecursion;
    },
    interface: add,
    modelProperty: add,
    scalar: add,
    scalarConstructor: add,
    enum: add,
    enumMember: add,
    union: add,
    unionVariant: add,
    tuple: add,
  };
  for (const type of pending) navigateType(type, listeners, {});
  return active;
}

function operationProvenance(operations: readonly Operation[]): ReadonlySet<Operation> {
  const provenance = new Set<Operation>();
  for (const operation of operations) {
    let source = operation.sourceOperation;
    while (source !== undefined && !provenance.has(source)) {
      provenance.add(source);
      source = source.sourceOperation;
    }
  }
  return provenance;
}

function liveDeclarations(
  root: Namespace,
  inventory: DocumentDeclarations,
  erased: ReadonlyMap<Namespace, ErasedRoots>,
): DocumentDeclarations {
  let global = root;
  while (global.namespace !== undefined) global = global.namespace;
  const discovered = discoverDocumentDeclarations(global);
  // Namespace mutation may leave unrelated subgraphs untouched. Only original
  // namespaces still present by identity may retain their pre-inventoried roots.
  const untouched = new Set(
    discovered.namespaces.filter((ns) => inventory.namespaces.includes(ns)),
  );
  const retained = [...erased]
    .filter(([namespace]) => untouched.has(namespace))
    .map(([, roots]) => roots);
  const models = [...discovered.models, ...retained.flatMap((roots) => roots.models)];
  const channels = [...discovered.channels, ...retained.flatMap((roots) => roots.interfaces)];
  const operations = [
    ...discovered.operations,
    ...retained.flatMap((roots) => roots.operations),
    ...retained.flatMap((roots) =>
      roots.interfaces.flatMap((channel) => [...channel.operations.values()]),
    ),
  ];
  return {
    ...discovered,
    models,
    channels,
    operations,
    diagnosticTargets: new Set([
      ...discovered.diagnosticTargets,
      ...models,
      ...channels,
      ...operations,
    ]),
  };
}
