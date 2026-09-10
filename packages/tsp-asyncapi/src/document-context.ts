import {
  getNamespaceFullName,
  ListenerFlow,
  navigateType,
  type Namespace,
  type Model,
  type Operation,
  type Program,
  type SemanticNodeListener,
  type Service,
  type Type,
} from "@typespec/compiler";
import type { unsafe_Realm as Realm } from "@typespec/compiler/experimental";
import { listMessages } from "tsp-asyncapi-core";
import { getMessageState, type DocumentDeclarations } from "tsp-asyncapi-core/unstable";
import type { SchemaArtifactInput } from "./schema-artifacts/provider.js";

/**
 * An adapter's selected graph. The Program is always the original Program;
 * a compiler mutation supplies a live root and optionally its realm.
 *
 * @internal
 */
export interface EffectiveDocumentGraph {
  readonly root: Namespace;
  readonly service: Service | undefined;
  readonly realm?: Realm;
  /**
   * Complete live candidates, including retained erased alias instances.
   * Service isolation requires this for changed graphs; explicit omission is
   * the adapter's removal decision, not permission to recover source state.
   */
  readonly declarations?: DocumentDeclarations;
  readonly version?: string;
  /** Resolved root/dependency values, keyed by original versioned namespace FQN. */
  readonly versionChoices?: ReadonlyMap<string, string>;
  /** Provenance for diagnostics only; never used for discovery or artifacts. */
  readonly sourceModels?: ReadonlyMap<Model, Model>;
}

/** Immutable inputs for one resolve/lower build. No per-build caches live here. @internal */
export interface DocumentContext {
  readonly program: Program;
  readonly originalService: Service | undefined;
  readonly originalServiceId: string | undefined;
  readonly service: Service | undefined;
  readonly root: Namespace;
  readonly realm: Realm | undefined;
  readonly version: string | undefined;
  readonly versionChoices: ReadonlyMap<string, string> | undefined;
  readonly sourceModels: ReadonlyMap<Model, Model> | undefined;
  /** Undefined explicitly selects legacy whole-program discovery. */
  readonly declarations: DocumentDeclarations | undefined;
  readonly artifactInput: SchemaArtifactInput;
}

/**
 * Creates one document's input boundary without selecting services or versions.
 * An effective graph opts into live discovery; ordinary callers retain today's
 * global declarations even when metadata comes from one service.
 *
 * @internal
 */
export function createDocumentContext(
  program: Program,
  originalService: Service | undefined,
  effective?: EffectiveDocumentGraph,
): DocumentContext {
  const root = effective?.root ?? program.getGlobalNamespaceType();
  const declarations =
    effective === undefined
      ? undefined
      : snapshotDeclarations(effective.declarations ?? discoverDocumentDeclarations(root));
  const models =
    declarations === undefined
      ? [...listMessages(program).keys()]
      : declarations.models.filter((model) => getMessageState(program, model) !== undefined);
  return Object.freeze({
    program,
    originalService,
    originalServiceId:
      originalService === undefined ? undefined : getNamespaceFullName(originalService.type),
    service: effective === undefined ? originalService : effective.service,
    root,
    realm: effective?.realm,
    version: effective?.version,
    versionChoices: effective?.versionChoices,
    sourceModels: effective?.sourceModels,
    declarations,
    artifactInput: Object.freeze({ program, models: Object.freeze(models) }),
  });
}

/**
 * Discovers reachable live declarations, not ownership. A service adapter can
 * narrow these sets and add diagnostic targets before creating its context.
 * State-map iteration is deliberately absent: it also contains removed types.
 *
 * @internal
 */
export function discoverDocumentDeclarations(root: Namespace): DocumentDeclarations {
  const types = new Set<Type>();
  const operations = new Set<Operation>();
  const add = (type: Type): ListenerFlow | undefined => {
    if (types.has(type)) return ListenerFlow.NoRecursion;
    types.add(type);
    return undefined;
  };
  const listeners: SemanticNodeListener = {
    namespace: add,
    interface: add,
    operation: () => ListenerFlow.NoRecursion,
    model: add,
    modelProperty: add,
    scalar: add,
    enum: add,
    union: add,
    unionVariant: add,
    tuple: add,
  };
  navigateType(
    root,
    {
      ...listeners,
      operation(operation) {
        operations.add(operation);
        add(operation);
        return ListenerFlow.NoRecursion;
      },
    },
    {},
  );
  // Operation.sourceOperation is provenance, not an emitted signature. Walk
  // only the effective parameters/return of operations contained in the root.
  for (const operation of operations) {
    for (const property of operation.parameters.properties.values()) {
      navigateType(property, listeners, {});
    }
    navigateType(operation.returnType, listeners, {});
  }
  return snapshotDeclarations({
    models: [...types].filter((type) => type.kind === "Model"),
    channels: [...types].filter((type) => type.kind === "Namespace" || type.kind === "Interface"),
    operations: [...operations],
    namespaces: [...types].filter((type) => type.kind === "Namespace"),
    diagnosticTargets: types,
  });
}

function snapshotDeclarations(declarations: DocumentDeclarations): DocumentDeclarations {
  return Object.freeze({
    models: Object.freeze([...new Set(declarations.models)]),
    channels: Object.freeze([...new Set(declarations.channels)]),
    operations: Object.freeze([...new Set(declarations.operations)]),
    namespaces: Object.freeze([...new Set(declarations.namespaces)]),
    ...(declarations.securitySchemes === undefined
      ? {}
      : {
          securitySchemes: new Map(
            [...declarations.securitySchemes].map(([namespace, names]) => [
              namespace,
              new Set(names),
            ]),
          ),
        }),
    diagnosticTargets: new Set(declarations.diagnosticTargets),
  });
}
