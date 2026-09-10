/**
 * Compiler 1.16 / versioning 0.86 adaptation. Mutate live type graphs, never
 * the original Program or its source types. Keep experimental calls here.
 */
import {
  compilerAssert,
  getService,
  getNamespaceFullName,
  isTemplateInstance,
  type Interface,
  type Model,
  type Namespace,
  type Operation,
  type Program,
  type Service,
} from "@typespec/compiler";
import { unsafe_mutateSubgraphWithNamespace } from "@typespec/compiler/experimental";
import { getVersioningMutators, resolveVersions } from "@typespec/versioning";
import { reportDiagnostic } from "tsp-asyncapi-core";
import { discoverDocumentDeclarations, type EffectiveDocumentGraph } from "./document-context.js";
import { discoverOriginalDocumentDeclarations } from "./service-context.js";
import type { DocumentDeclarations } from "tsp-asyncapi-core/unstable";

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
        const { type, realm } = unsafe_mutateSubgraphWithNamespace(
          program,
          [
            {
              name: "AsyncAPI erased declaration roots",
              Namespace(source, clone) {
                const aliases = erased.get(source);
                if (aliases === undefined) return;
                insertRoots(clone.models, aliases.models);
                insertRoots(clone.interfaces, aliases.interfaces);
                insertRoots(clone.operations, aliases.operations);
              },
            },
            mutator,
            {
              name: "AsyncAPI version provenance",
              Model(source, clone) {
                sourceModels.set(clone, source);
              },
            },
          ],
          root,
        );
        compilerAssert(type.kind === "Namespace", "Versioning must preserve the namespace root.");
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
            declarations: liveDeclarations(type, inventory, erased),
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

function insertRoots<T>(map: Map<string, T>, roots: readonly T[]): void {
  let index = 0;
  for (const root of roots) {
    while (map.has(`__asyncapi_version_instance_${String(index)}`)) index++;
    map.set(`__asyncapi_version_instance_${String(index++)}`, root);
  }
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
