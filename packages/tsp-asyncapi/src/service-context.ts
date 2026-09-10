import {
  getNamespaceFullName,
  getTypeName,
  ListenerFlow,
  navigateType,
  type Model,
  type Namespace,
  type Operation,
  type Program,
  type Service,
  type Type,
} from "@typespec/compiler";
import {
  getChannel,
  getHeadersModel,
  getOperationAction,
  getReplyChannel,
  getUsedSecuritySchemes,
  listChannels,
  listMessages,
  reportDiagnostic,
} from "tsp-asyncapi-core";
import {
  getMessageState,
  getOperationMessageModels,
  getSecuritySchemeNames,
  listOperationActionTargets,
  serviceOwner,
  type DocumentDeclarations,
} from "tsp-asyncapi-core/unstable";
import {
  createDocumentContext,
  discoverDocumentDeclarations,
  type DocumentContext,
  type EffectiveDocumentGraph,
} from "./document-context.js";
import { resolveDiscriminator } from "./lower/schemas/inheritance.js";

function channelOf(operation: Operation) {
  return operation.interface ?? operation.namespace;
}

function isOnChannel(program: Program, operation: Operation): boolean {
  const channel = channelOf(operation);
  return channel !== undefined && getChannel(program, channel) !== undefined;
}

function sourceCarriers(program: Program, operations: readonly Operation[]) {
  const carried = new Set<Operation>();
  for (const operation of operations) {
    if (
      serviceOwner(program, operation) === undefined ||
      !isOnChannel(program, operation) ||
      getOperationAction(program, operation) === undefined
    )
      continue;
    collectOperationSources(operation, carried);
  }
  return carried;
}

function collectOperationSources(operation: Operation, carried: Set<Operation>): void {
  const pending = [operation];
  for (const source of pending) {
    if (carried.has(source)) continue;
    carried.add(source);
    if (source.sourceOperation !== undefined) pending.push(source.sourceOperation);
    for (const base of source.interface?.sourceInterfaces ?? []) {
      const inherited = base.operations.get(source.name);
      if (inherited !== undefined && inherited.node === source.node) pending.push(inherited);
    }
  }
}

/** Validate original application roots once, even when a selector excludes some services. @internal */
export function validateServiceOwnership(program: Program, services: readonly Service[]): void {
  if (services.length < 2) return;
  const declarations = discoverOriginalDocumentDeclarations(program);
  const carried = sourceCarriers(program, declarations.operations);
  for (const channel of declarations.channels) {
    if (serviceOwner(program, channel) !== undefined || getChannel(program, channel) === undefined)
      continue;
    reportDiagnostic(program, {
      code: "unowned-application-declaration",
      target: channel,
      format: { name: getTypeName(channel) },
    });
  }
  for (const operation of declarations.operations) {
    if (
      serviceOwner(program, operation) !== undefined ||
      getOperationAction(program, operation) === undefined ||
      carried.has(operation)
    )
      continue;
    if (isOnChannel(program, operation)) continue;
    reportDiagnostic(program, {
      code: "unowned-application-declaration",
      target: operation,
      format: { name: getTypeName(operation) },
    });
  }
}

/** Original-only inventory, captured before mutation can replay erased instance state. @internal */
export function discoverOriginalDocumentDeclarations(program: Program): DocumentDeclarations {
  const declarations = discoverDocumentDeclarations(program.getGlobalNamespaceType());
  const models = new Set(declarations.models);
  const channels = new Set(declarations.channels);
  const operations = new Set(declarations.operations);
  const diagnosticTargets = new Set(declarations.diagnosticTargets);
  const addOperation = (operation: Operation): void => {
    if (!operation.isFinished) return;
    operations.add(operation);
    diagnosticTargets.add(operation);
  };
  // Aliases erase otherwise unused template instantiations from namespace maps.
  // Supplement only the original graph; realm discovery must never use state lists.
  const namespaces = new Set(declarations.namespaces);
  for (const model of listMessages(program).keys()) {
    if (model.namespace === undefined || namespaces.has(model.namespace)) models.add(model);
  }
  for (const operation of listOperationActionTargets(program)) {
    const namespace = operation.interface?.namespace ?? operation.namespace;
    if (namespace !== undefined && !namespaces.has(namespace)) continue;
    addOperation(operation);
  }
  for (const channel of listChannels(program).keys()) {
    const namespace = channel.kind === "Namespace" ? channel : channel.namespace;
    if (namespace !== undefined && !namespaces.has(namespace)) continue;
    channels.add(channel);
    diagnosticTargets.add(channel);
    for (const operation of channel.operations.values()) addOperation(operation);
  }
  return {
    ...declarations,
    models: [...models],
    channels: [...channels],
    operations: [...operations],
    diagnosticTargets,
  };
}

type Owns = (type: Type) => boolean;
type CheckContract = (type: Type, target: Type) => boolean;

/** Live transitive subtype closure shared by ownership and replay validation. @internal */
export function discriminatorSubtypes(program: Program, model: Model): readonly Model[] {
  if (resolveDiscriminator(program, model).kind !== "applies") return [];
  const descendants = new Set<Model>();
  const pending = [...model.derivedModels];
  for (const subtype of pending) {
    if (descendants.has(subtype)) continue;
    descendants.add(subtype);
    pending.push(...subtype.derivedModels);
  }
  return [...descendants];
}

function contractChecker(
  program: Program,
  originalService: Service,
  root: Namespace,
): CheckContract {
  const foreign = new Set<Type>();
  return (type, target) => {
    const owner = serviceOwner(program, type);
    if (owner === undefined || owner === root) return true;
    if (!foreign.has(type)) {
      foreign.add(type);
      reportDiagnostic(program, {
        code: "cross-service-reference",
        target,
        format: {
          service: getNamespaceFullName(originalService.type),
          name: getTypeName(type),
          owner: getNamespaceFullName(owner),
        },
      });
    }
    return false;
  };
}

function addSignatureMessages(
  program: Program,
  operation: Operation,
  models: Set<Model>,
  diagnosticTargets: Set<Type>,
  checkContract: CheckContract,
): void {
  for (const model of getOperationMessageModels(program, operation)) {
    if (getMessageState(program, model) === undefined || !checkContract(model, operation)) continue;
    models.add(model);
    diagnosticTargets.add(model);
  }
  const reply = getReplyChannel(program, operation);
  if (reply !== undefined) checkContract(reply, operation);
  for (const property of operation.parameters.properties.values()) diagnosticTargets.add(property);
}

function checkMessageReferences(
  program: Program,
  models: ReadonlySet<Model>,
  owns: Owns,
  diagnosticTargets: Set<Type>,
  checkContract: CheckContract,
): void {
  const queue = [...models].filter((model) => getMessageState(program, model) !== undefined);
  const visited = new Set<Model>();
  for (const message of queue) {
    navigateType(
      message,
      {
        model(model) {
          if (visited.has(model)) return ListenerFlow.NoRecursion;
          visited.add(model);
          if (getMessageState(program, model) !== undefined) checkContract(model, message);
          if (serviceOwner(program, model) === undefined || owns(model)) {
            diagnosticTargets.add(model);
            for (const property of model.properties.values()) diagnosticTargets.add(property);
          }
          const headers = getHeadersModel(program, model);
          if (headers !== undefined) queue.push(headers);
          queue.push(...discriminatorSubtypes(program, model));
          return undefined;
        },
        operation: () => ListenerFlow.NoRecursion,
      },
      {},
    );
  }
}

function visibleSecuritySchemes(
  program: Program,
  namespaces: readonly Namespace[],
  operations: readonly Operation[],
  service: Service | undefined,
  owns: Owns,
): ReadonlyMap<Namespace, ReadonlySet<string>> {
  const usedSecurity = new Set([
    ...(service === undefined ? [] : getUsedSecuritySchemes(program, service.type)),
    ...operations
      .filter((operation) => getOperationAction(program, operation) !== undefined)
      .flatMap((operation) => getUsedSecuritySchemes(program, operation)),
  ]);
  const securitySchemes = new Map<Namespace, ReadonlySet<string>>();
  for (const namespace of namespaces) {
    const owned = owns(namespace);
    if (!owned && serviceOwner(program, namespace) !== undefined) continue;
    const selected = getSecuritySchemeNames(program, namespace).filter(
      (name) => owned || usedSecurity.has(name),
    );
    if (selected.length > 0) securitySchemes.set(namespace, new Set(selected));
  }
  return securitySchemes;
}

function hasStaleDeclarations(
  program: Program,
  service: Service | undefined,
  effective: EffectiveDocumentGraph,
  declarations: DocumentDeclarations,
): boolean {
  if (service === undefined || service.type === effective.root) return false;
  const types = [
    ...declarations.models,
    ...declarations.channels,
    ...declarations.operations,
    ...declarations.namespaces,
  ];
  const stale = types.find((type) => serviceOwner(program, type) === service.type);
  if (stale === undefined) return false;
  reportDiagnostic(program, {
    code: "stale-effective-declaration",
    target: stale,
    format: { service: getNamespaceFullName(service.type), name: getTypeName(stale) },
  });
  return true;
}

/**
 * Apply service ownership to a live graph without modifying it. The full original
 * service list controls compatibility; a version adapter may supply an effective
 * namespace/service/realm on the same original Program.
 * A changed graph must provide a complete live declaration boundary. Undefined
 * reports a refused boundary; callers must withhold the complete output set.
 *
 * @internal
 */
export function createServiceDocumentContext(
  program: Program,
  originalService: Service | undefined,
  originalServices: readonly Service[],
  effective?: EffectiveDocumentGraph,
): DocumentContext | undefined {
  const originalRoot = originalService?.type ?? program.getGlobalNamespaceType();
  if (
    effective !== undefined &&
    effective.declarations === undefined &&
    (effective.root !== originalRoot || effective.realm !== undefined)
  ) {
    reportDiagnostic(program, {
      code: "incomplete-effective-document",
      target: originalRoot,
      format: { service: getNamespaceFullName(originalRoot) || "(global)" },
    });
    return undefined;
  }
  if (
    effective?.declarations !== undefined &&
    hasStaleDeclarations(program, originalService, effective, effective.declarations)
  )
    return undefined;
  if (originalService === undefined) {
    return createDocumentContext(
      program,
      undefined,
      effective?.declarations === undefined ? undefined : effective,
    );
  }
  const root = effective?.root ?? originalService.type;
  const service = effective === undefined ? originalService : effective.service;
  const all = effective?.declarations ?? discoverOriginalDocumentDeclarations(program);
  const owns: Owns = (type) => {
    const owner = serviceOwner(program, type);
    return owner === root || (owner === undefined && originalServices.length === 1);
  };
  const models = new Set(all.models.filter(owns));
  const channels = all.channels.filter(owns);
  const operations = all.operations.filter(owns);
  const diagnosticTargets = new Set([...all.diagnosticTargets].filter(owns));
  const checkContract = contractChecker(program, originalService, root);
  for (const operation of operations) {
    if (getOperationAction(program, operation) !== undefined || isOnChannel(program, operation)) {
      addSignatureMessages(program, operation, models, diagnosticTargets, checkContract);
    }
  }
  checkMessageReferences(program, models, owns, diagnosticTargets, checkContract);
  const securitySchemes = visibleSecuritySchemes(
    program,
    all.namespaces,
    operations,
    service,
    owns,
  );
  const declarations: DocumentDeclarations = {
    models: [...models],
    channels,
    operations,
    namespaces: [...new Set([...all.namespaces.filter(owns), ...securitySchemes.keys()])],
    securitySchemes,
    diagnosticTargets,
  };
  return createDocumentContext(program, originalService, {
    ...effective,
    root,
    service,
    declarations,
  });
}
