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
  listMessages,
  reportDiagnostic,
} from "tsp-asyncapi-core";
import {
  getMessageState,
  getOperationMessageModels,
  getSecuritySchemeNames,
  serviceOwner,
  type DocumentDeclarations,
} from "tsp-asyncapi-core/unstable";
import {
  createDocumentContext,
  discoverDocumentDeclarations,
  type DocumentContext,
  type EffectiveDocumentGraph,
} from "./document-context.js";

function globalRoot(namespace: Namespace): Namespace {
  while (namespace.namespace !== undefined) namespace = namespace.namespace;
  return namespace;
}

function channelOf(operation: Operation) {
  return operation.interface ?? operation.namespace;
}

function isOnChannel(program: Program, operation: Operation): boolean {
  const channel = channelOf(operation);
  return channel !== undefined && getChannel(program, channel) !== undefined;
}

function sourceCarriers(program: Program, operations: readonly Operation[]) {
  const carried = new Set<Operation["node"]>();
  for (const operation of operations) {
    if (
      serviceOwner(program, operation) === undefined ||
      !isOnChannel(program, operation) ||
      getOperationAction(program, operation) === undefined
    )
      continue;
    const seen = new Set<Operation>();
    let source: Operation | undefined = operation;
    while (source !== undefined && !seen.has(source)) {
      seen.add(source);
      if (source.node !== undefined) carried.add(source.node);
      source = source.sourceOperation;
    }
  }
  return carried;
}

/** Validate original application roots once, even when a selector excludes some services. @internal */
export function validateServiceOwnership(program: Program, services: readonly Service[]): void {
  if (services.length < 2) return;
  const declarations = discoverDocumentDeclarations(program.getGlobalNamespaceType());
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
      (operation.node !== undefined && carried.has(operation.node))
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

function sourceModels(program: Program, declarations: DocumentDeclarations): ReadonlySet<Model> {
  const models = new Set(declarations.models);
  // Preserve otherwise unused original template instantiations, which the
  // compiler stores in state but not in namespace.models. Never use this for a realm.
  const namespaces = new Set(declarations.namespaces);
  for (const model of listMessages(program).keys()) {
    if (model.namespace === undefined || namespaces.has(model.namespace)) models.add(model);
  }
  return models;
}

type Owns = (type: Type) => boolean;
type CheckContract = (type: Type, target: Type) => boolean;

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

/**
 * Apply service ownership to a live graph without modifying it. The full original
 * service list controls compatibility; a version adapter may supply an effective
 * namespace/service/realm on the same original Program.
 *
 * @internal
 */
export function createServiceDocumentContext(
  program: Program,
  originalService: Service | undefined,
  originalServices: readonly Service[],
  effective?: EffectiveDocumentGraph,
): DocumentContext {
  if (originalService === undefined) return createDocumentContext(program, undefined, effective);
  const root = effective?.root ?? originalService.type;
  const service = effective === undefined ? originalService : effective.service;
  const all = effective?.declarations ?? discoverDocumentDeclarations(globalRoot(root));
  const owns: Owns = (type) => {
    const owner = serviceOwner(program, type);
    return owner === root || (owner === undefined && originalServices.length === 1);
  };
  const candidates = effective === undefined ? sourceModels(program, all) : all.models;
  const models = new Set([...candidates].filter(owns));
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
