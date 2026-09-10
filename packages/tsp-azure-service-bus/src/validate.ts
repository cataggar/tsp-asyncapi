import {
  getNamespaceFullName,
  getSourceLocation,
  getTypeName,
  isService,
  listServices,
  navigateProgram,
  type DecoratorApplication,
  type Model,
  type Namespace,
  type Operation,
  type Program,
  type Type,
} from "@typespec/compiler";
import { getVersioningMutators } from "@typespec/versioning";
import {
  getBindings,
  getChannel,
  getExtensions,
  getOperationAction,
  getReplyAddress,
  getReplyChannel,
  getServers,
  getUsedServers,
  listChannels,
  listMessages,
  type ChannelTarget,
} from "tsp-asyncapi-core";
import { checkProfile, EXTENSION_KEY } from "./profile.js";
import { getProfile, problem, read, records, write } from "./state.js";
import { validateLocation, validateMessage } from "./message-validation.js";
import { validateSecurity } from "./security-validation.js";
import type {
  ChannelProfile,
  DeploymentRequirements,
  MessageProfile,
  NativeReply,
  OperationProfile,
  ServiceBusProfile,
} from "./types.js";

function isRawProfile(application: DecoratorApplication): boolean {
  const definition = application.definition;
  return (
    definition?.name.replace(/^[@$]/u, "") === "extension" &&
    getNamespaceFullName(definition.namespace) === "AsyncAPI" &&
    application.args[0]?.jsValue === EXTENSION_KEY
  );
}

function isTypedProfile(application: DecoratorApplication): boolean {
  const definition = application.definition;
  return (
    definition !== undefined &&
    getNamespaceFullName(definition.namespace) === "Azure.ServiceBus" &&
    ["infoProfile", "channelProfile", "messageProfile", "operationProfile"].includes(
      definition.name.replace(/^[@$]/u, ""),
    )
  );
}

function expectedTarget(
  program: Program,
  target: Type,
  messages: ReadonlyMap<Model, unknown>,
): ServiceBusProfile["target"] | undefined {
  if (target.kind === "Namespace" && isService(program, target)) {
    if (getChannel(program, target)) return undefined;
    return "info";
  }
  if ((target.kind === "Namespace" || target.kind === "Interface") && getChannel(program, target))
    return "channel";
  if (target.kind === "Model" && messages.has(target)) return "message";
  if (target.kind === "Operation" && getOperationAction(program, target)) return "operation";
  return undefined;
}

function discover(program: Program, messages: ReadonlyMap<Model, unknown>): Type[] {
  const found = new Set<Type>(records(program).keys());
  const visit = (target: Type) => {
    if (
      getExtensions(program, target).has(EXTENSION_KEY) ||
      ("decorators" in target && target.decorators.some(isRawProfile))
    )
      found.add(target);
  };
  navigateProgram(program, {
    namespace: visit,
    interface: visit,
    model: visit,
    modelProperty: visit,
    operation: visit,
    scalar: visit,
    union: visit,
    unionVariant: visit,
    enum: visit,
    enumMember: visit,
  });
  const targets = [...found].sort((a, b) => {
    const left = getSourceLocation(a),
      right = getSourceLocation(b);
    if (left.file.path === right.file.path) return left.pos - right.pos;
    return left.file.path < right.file.path ? -1 : 1;
  });
  for (const target of targets) {
    const expected = expectedTarget(program, target, messages);
    if (expected === undefined) {
      problem(
        program,
        target,
        "profile-placement",
        "A profile must target a service info, marked channel/message/action; a service must not also be a channel.",
      );
      continue;
    }
    const applications =
      "decorators" in target
        ? target.decorators.filter(
            (application) => isRawProfile(application) || isTypedProfile(application),
          )
        : [];
    const unique = new Set(applications.map((application) => application.node ?? application));
    if (unique.size > 1)
      problem(
        program,
        target,
        "profile-conflict",
        "Typed/raw profile declarations share one key. Declare one composite profile; values are never merged.",
      );
    const raw = applications.find(isRawProfile);
    const source = read(program, target)?.source ?? raw?.args[1]?.node ?? target;
    const value = getExtensions(program, target).get(EXTENSION_KEY);
    const profile = checkProfile(program, source, expected, value);
    if (profile)
      write(program, target, { profile, source, application: read(program, target)?.application });
  }
  return targets;
}

function namespaceOf(target: Type): Namespace | undefined {
  if (target.kind === "Namespace") return target;
  if (target.kind === "ModelProperty") return target.model?.namespace;
  if (target.kind === "Operation") return target.interface?.namespace ?? target.namespace;
  return "namespace" in target ? target.namespace : undefined;
}

function channelProfile(program: Program, target: ChannelTarget): ChannelProfile | undefined {
  const profile = getProfile(program, target);
  return profile?.target === "channel" ? profile : undefined;
}

function messageProfile(program: Program, target: Model): MessageProfile | undefined {
  const profile = getProfile(program, target);
  return profile?.target === "message" ? profile : undefined;
}

function requireProfile(program: Program, target: Type, kind: ServiceBusProfile["target"]): void {
  if (getProfile(program, target)?.target !== kind)
    problem(
      program,
      target,
      "profile-placement",
      `Every participating Service Bus ${kind} requires its matching composite profile.`,
    );
}

function validateBindings(
  program: Program,
  target: Type,
  scope: "server" | "channel" | "message" | "operation",
): void {
  for (const binding of getBindings(program, target)) {
    if (binding.scope !== "any" && binding.scope !== scope) continue;
    if (binding.protocol !== "amqp1" || Object.keys(binding.config).length !== 0) {
      problem(
        program,
        target,
        "transport-conflict",
        `${scope} bindings must be absent or amqp1:{}. '${binding.protocol}' is incompatible; AMQP 0-9-1 and nonempty amqp1 are not supported.`,
      );
    }
  }
}

function validateChannel(program: Program, target: ChannelTarget, profile: ChannelProfile): void {
  const { entity, deploymentRequirements: requirements } = profile;
  if (entity.kind === "subscription" && entity.id === entity.topicId) {
    problem(program, target, "topology-conflict", "A subscription cannot be its own parent topic.");
  }
  if (
    requirements?.allowedTiers?.includes("basic") &&
    (entity.kind !== "queue" ||
      requirements.sessions ||
      requirements.duplicateDetection ||
      (requirements.defaultTtlSeconds ?? 0) > 1209600)
  ) {
    problem(
      program,
      target,
      "deployment-incompatible",
      "Basic cannot meet topic/subscription, session, duplicate-detection or TTL-over-14-days requirements.",
    );
  }
  const address = getChannel(program, target)?.address;
  if (address?.toLowerCase().includes("$deadletterqueue")) {
    problem(
      program,
      target,
      "profile-unsupported",
      "Dedicated dead-letter subqueue channels are outside profile 0.1.0.",
    );
  }
  validateBindings(program, target, "channel");
}

function intersectRequirements(
  program: Program,
  target: ChannelTarget,
  related: ChannelTarget,
  previous: DeploymentRequirements,
  next: DeploymentRequirements,
): DeploymentRequirements {
  const merged = { ...previous, ...next };
  const aliases = `Aliases '${getTypeName(target)}' and '${getTypeName(related)}'`;
  for (const key of [
    "sessions",
    "partitioning",
    "lockDurationSeconds",
    "maxDeliveryCount",
    "defaultTtlSeconds",
    "deadLetterOnExpiration",
  ] as const) {
    if (previous[key] !== undefined && next[key] !== undefined && previous[key] !== next[key]) {
      problem(
        program,
        target,
        "topology-conflict",
        `${aliases} of one logical entity disagree on '${key}'.`,
      );
    }
  }
  if (previous.duplicateDetection && next.duplicateDetection) {
    const oldWindow = previous.duplicateDetection.historyWindowSeconds,
      newWindow = next.duplicateDetection.historyWindowSeconds;
    if (oldWindow !== undefined && newWindow !== undefined && oldWindow !== newWindow) {
      problem(
        program,
        target,
        "topology-conflict",
        `${aliases} disagree on the duplicate-detection history window.`,
      );
    }
    merged.duplicateDetection = { ...previous.duplicateDetection, ...next.duplicateDetection };
  }
  if (previous.allowedTiers && next.allowedTiers) {
    merged.allowedTiers = previous.allowedTiers.filter((tier) => next.allowedTiers?.includes(tier));
    if (merged.allowedTiers.length === 0)
      problem(
        program,
        target,
        "topology-conflict",
        `${aliases} have an empty allowedTiers intersection.`,
      );
  }
  return merged;
}

interface LogicalEntity {
  readonly profile: ChannelProfile;
  readonly target: ChannelTarget;
  requirements: DeploymentRequirements;
}

function topology(program: Program, targets: readonly ChannelTarget[]): Map<string, LogicalEntity> {
  const entities = new Map<string, LogicalEntity>();
  for (const target of targets) {
    const profile = channelProfile(program, target);
    if (!profile) continue;
    validateChannel(program, target, profile);
    const previous = entities.get(profile.entity.id);
    if (previous) {
      if (
        previous.profile.entity.kind !== profile.entity.kind ||
        previous.profile.entity.topicId !== profile.entity.topicId
      ) {
        problem(
          program,
          target,
          "topology-conflict",
          `Logical ID '${profile.entity.id}' has conflicting kinds or parent topics.`,
        );
      }
      previous.requirements = intersectRequirements(
        program,
        target,
        previous.target,
        previous.requirements,
        profile.deploymentRequirements ?? {},
      );
    } else {
      entities.set(profile.entity.id, {
        profile,
        target,
        requirements: profile.deploymentRequirements ?? {},
      });
    }
  }
  for (const { target, profile, requirements } of entities.values()) {
    validateChannel(program, target, { ...profile, deploymentRequirements: requirements });
    if (profile.entity.kind !== "subscription") continue;
    const parent = entities.get(profile.entity.topicId);
    if (parent && parent.profile.entity.kind !== "topic")
      problem(
        program,
        target,
        "topology-conflict",
        `Parent '${profile.entity.topicId}' is not a topic.`,
      );
  }
  return entities;
}

function signatureModels(
  type: Type,
  messages: ReadonlyMap<Model, unknown>,
  seen = new Set<Type>(),
): Model[] {
  if (seen.has(type)) return [];
  seen.add(type);
  if (type.kind === "Union")
    return [...type.variants.values()].flatMap((variant) =>
      signatureModels(variant.type, messages, seen),
    );
  if (type.kind !== "Model") return [];
  if (!messages.has(type) && type.indexer && type.properties.size === 0)
    return signatureModels(type.indexer.value, messages, seen);
  return [type];
}

function requireNative(
  program: Program,
  model: Model,
  name: keyof NonNullable<MessageProfile["nativeProperties"]>,
  reason: string,
): void {
  if (messageProfile(program, model)?.nativeProperties?.[name]?.required !== true) {
    problem(
      program,
      model,
      "native-metadata",
      `${reason}: '${model.name}' must require native ${name}.`,
    );
  }
}

function validateTraffic(
  program: Program,
  operation: Operation,
  target: ChannelTarget,
  action: "send" | "receive",
  models: readonly Model[],
  entities: ReadonlyMap<string, LogicalEntity>,
): void {
  requireProfile(program, target, "channel");
  const channel = channelProfile(program, target);
  if (!channel) return;
  const logical = entities.get(channel.entity.id);
  const requirements = logical?.requirements ?? channel.deploymentRequirements;
  if (
    (action === "send" && channel.entity.kind === "subscription") ||
    (action === "receive" && channel.entity.kind === "topic")
  ) {
    problem(
      program,
      operation,
      "entity-direction",
      `Cannot ${action} on a ${channel.entity.kind}; action is application-relative.`,
    );
  }
  const parent =
    channel.entity.kind === "subscription" ? entities.get(channel.entity.topicId) : undefined;
  for (const model of models) {
    requireProfile(program, model, "message");
    if (requirements?.sessions)
      requireNative(
        program,
        model,
        "SessionId",
        `Session-enabled queue/subscription '${channel.entity.id}'`,
      );
    if (requirements?.duplicateDetection && action === "send")
      requireNative(
        program,
        model,
        "MessageId",
        `Ingress duplicate detection on '${channel.entity.id}'`,
      );
    validateTtl(program, model, channel.entity.id, requirements, parent?.requirements);
  }
}

function validateTtl(
  program: Program,
  model: Model,
  entityId: string,
  requirements?: DeploymentRequirements,
  parent?: DeploymentRequirements,
): void {
  const ttl = messageProfile(program, model)?.ttlSeconds;
  const ceilings = [requirements?.defaultTtlSeconds, parent?.defaultTtlSeconds];
  if (requirements?.allowedTiers?.includes("basic")) ceilings.push(1209600);
  if (ttl !== undefined && ceilings.some((ceiling) => ceiling !== undefined && ttl > ceiling)) {
    problem(
      program,
      model,
      "deployment-incompatible",
      `Message TTL ${String(ttl)} exceeds a known queue/topic/subscription ceiling on '${entityId}'.`,
    );
  }
}

function validateNativeReplyChannel(
  program: Program,
  operation: Operation,
  native: NativeReply,
  replyChannel: ChannelTarget,
  entities: ReadonlyMap<string, LogicalEntity>,
): void {
  const channel = channelProfile(program, replyChannel);
  if (channel && channel.entity.kind !== "queue")
    problem(
      program,
      operation,
      "profile-unsupported",
      "Native replies in 0.1.0 require a queue destination.",
    );
  if (getReplyAddress(program, operation))
    problem(
      program,
      operation,
      "reply-conflict",
      "nativeReply and standard @replyAddress cannot be competing address authorities.",
    );
  if (native.address === "requestReplyTo" && getChannel(program, replyChannel)?.address !== null) {
    problem(
      program,
      operation,
      "reply-conflict",
      "Native requestReplyTo requires a null-address reply channel.",
    );
  }
  if (
    native.session &&
    (!channel || entities.get(channel.entity.id)?.requirements.sessions !== true)
  ) {
    problem(
      program,
      operation,
      "reply-conflict",
      "Native session replies require sessions:true on the reply queue.",
    );
  }
}

function validateReply(
  program: Program,
  operation: Operation,
  profile: OperationProfile,
  request: readonly Model[],
  reply: readonly Model[],
  replyChannel: ChannelTarget | undefined,
  entities: ReadonlyMap<string, LogicalEntity>,
): void {
  const native = profile.nativeReply;
  if (!native) return;
  if (!replyChannel || reply.length === 0 || request.length === 0) {
    problem(
      program,
      operation,
      "reply-conflict",
      "nativeReply requires request/reply messages and explicit standard @replyChannel.",
    );
    return;
  }
  validateNativeReplyChannel(program, operation, native, replyChannel, entities);
  for (const model of request) {
    requireNative(program, model, "MessageId", "Native request/reply correlation");
    if (native.address === "requestReplyTo")
      requireNative(program, model, "ReplyTo", "Native reply routing");
    if (native.session) requireNative(program, model, "ReplyToSessionId", "Native session reply");
  }
  for (const model of reply) {
    requireNative(program, model, "CorrelationId", "Native request/reply correlation");
    if (native.session) requireNative(program, model, "SessionId", "Native session reply");
  }
}

interface OperationContext {
  readonly program: Program;
  readonly operation: Operation;
  readonly owner: ChannelTarget;
  readonly config: OperationProfile;
  readonly action: "send" | "receive";
  readonly request: readonly Model[];
  readonly reply: readonly Model[];
  readonly replyChannel?: ChannelTarget;
  readonly entities: ReadonlyMap<string, LogicalEntity>;
}

function validateOperationRequirements(context: OperationContext): void {
  const { program, operation, owner, config, action, request, entities } = context;
  const ownerProfile = channelProfile(program, owner);
  const requirements = ownerProfile && entities.get(ownerProfile.entity.id)?.requirements;
  if (config.deliveryRequirements?.order) {
    if (requirements?.sessions !== true)
      problem(
        program,
        operation,
        "delivery-conflict",
        "Per-session order requires sessions:true on the receiving queue/subscription.",
      );
    for (const model of request) requireNative(program, model, "SessionId", "Per-session order");
  }
  if (
    action === "send" &&
    (requirements?.duplicateDetection || config.applicationObligations?.messageIdentity)
  ) {
    if (!config.applicationObligations?.messageIdentity)
      problem(
        program,
        operation,
        "delivery-conflict",
        "Duplicate detection requires explicit uniquePerMessageStableOnRetry identity handling.",
      );
    for (const model of request)
      requireNative(program, model, "MessageId", "Send identity handling");
  }
}

function validateOperationReplies(context: OperationContext): void {
  const { program, operation, config, action, request, reply, replyChannel, entities } = context;
  if (reply.length > 0) {
    if (!replyChannel)
      problem(
        program,
        operation,
        "reply-conflict",
        "Profile request/reply requires explicit @replyChannel; the core same-channel default is not used.",
      );
    else
      validateTraffic(
        program,
        operation,
        replyChannel,
        action === "send" ? "receive" : "send",
        reply,
        entities,
      );
  }
  const address = getReplyAddress(program, operation);
  if (address && !config.nativeReply) {
    for (const model of request) validateLocation(program, model, address.location, operation);
    if (
      !replyChannel ||
      getChannel(program, replyChannel)?.address !== null ||
      reply.length === 0
    ) {
      problem(
        program,
        operation,
        "reply-conflict",
        "Standard reply.address requires reply messages and an explicit null-address reply channel.",
      );
    }
  }
  validateReply(program, operation, config, request, reply, replyChannel, entities);
  validateReplyIdentity(context);
}

function validateReplyIdentity(context: OperationContext): void {
  const { program, operation, action, replyChannel, reply, entities } = context;
  if (action !== "receive" || !replyChannel) return;
  const channel = channelProfile(program, replyChannel);
  if (!channel || !entities.get(channel.entity.id)?.requirements.duplicateDetection) return;
  const covered = explicitIdentityMessages(program, channel.entity.id);
  if (reply.some((model) => !covered.has(model))) {
    problem(
      program,
      operation,
      "delivery-conflict",
      "Reply sends to a duplicate-detecting entity require an explicit profiled @send operation covering the reply messages with uniquePerMessageStableOnRetry.",
    );
  }
}

function explicitIdentityMessages(program: Program, entityId: string): Set<Model> {
  const covered = new Set<Model>();
  const messages = listMessages(program);
  for (const target of listChannels(program).keys()) {
    if (channelProfile(program, target)?.entity.id !== entityId) continue;
    for (const operation of target.operations.values()) {
      const profile = getProfile(program, operation);
      if (
        profile?.target !== "operation" ||
        getOperationAction(program, operation)?.action !== "send" ||
        !profile.applicationObligations?.messageIdentity
      )
        continue;
      for (const property of operation.parameters.properties.values()) {
        signatureModels(property.type, messages).forEach((model) => covered.add(model));
      }
    }
  }
  return covered;
}

function validateOperation(
  program: Program,
  operation: Operation,
  owner: ChannelTarget | undefined,
  messages: ReadonlyMap<Model, unknown>,
  entities: ReadonlyMap<string, LogicalEntity>,
): void {
  const config = getProfile(program, operation);
  const action = getOperationAction(program, operation)?.action;
  const parameters = [...operation.parameters.properties.values()].flatMap((property) =>
    signatureModels(property.type, messages),
  );
  const returns = signatureModels(operation.returnType, messages);
  const request = action === "send" ? parameters : returns,
    reply = action === "send" ? returns : parameters;
  const replyChannel = getReplyChannel(program, operation);
  const relevant =
    Boolean(config) ||
    (owner !== undefined && Boolean(channelProfile(program, owner))) ||
    (replyChannel !== undefined && Boolean(channelProfile(program, replyChannel))) ||
    [...request, ...reply].some((model) => messageProfile(program, model));
  if (!relevant) return;
  requireProfile(program, operation, "operation");
  if (!owner || !getChannel(program, owner)) {
    problem(
      program,
      operation,
      "profile-placement",
      "A profiled operation requires a directly owning AsyncAPI channel.",
    );
    return;
  }
  if (!action || config?.target !== "operation") return;
  if (config.action !== action)
    problem(
      program,
      operation,
      "profile-conflict",
      "Profile action must equal standard @send/@receive.",
    );
  if (request.length === 0)
    problem(
      program,
      operation,
      "profile-placement",
      "A profiled operation must name at least one marked request message.",
    );
  validateTraffic(program, operation, owner, action, request, entities);
  validateBindings(program, operation, "operation");
  validateSecurity(program, operation, config.authorizationRequirements?.authentication);
  const context = {
    program,
    operation,
    owner,
    config,
    action,
    request,
    reply,
    replyChannel,
    entities,
  };
  validateOperationRequirements(context);
  validateOperationReplies(context);
}

function supportedService(program: Program, targets: readonly Type[]): Namespace | undefined {
  const services = listServices(program);
  if (services.length !== 1) {
    problem(
      program,
      targets[0],
      services.length === 0 ? "profile-placement" : "profile-unsupported",
      "Profile 0.1.0 requires exactly one unversioned application service per compilation; multi-service validation is not implemented.",
    );
    return;
  }
  const service = services[0].type;
  const namespaces = new Set([service, ...targets.flatMap((target) => namespaceOf(target) ?? [])]);
  if (
    [...namespaces].some((namespace) => getVersioningMutators(program, namespace) !== undefined)
  ) {
    problem(
      program,
      service,
      "profile-unsupported",
      "Versioned and dependency-mutated profile graphs require future snapshot-scoped validation; no projected conformance is claimed.",
    );
    return;
  }
  return service;
}

function validateOperations(
  program: Program,
  channels: readonly ChannelTarget[],
  messages: ReadonlyMap<Model, unknown>,
  entities: ReadonlyMap<string, LogicalEntity>,
): void {
  const visited = new Set<Operation>();
  for (const owner of channels) {
    for (const operation of owner.operations.values()) {
      visited.add(operation);
      validateOperation(program, operation, owner, messages, entities);
    }
  }
  navigateProgram(program, {
    operation: (operation) => {
      if (!visited.has(operation))
        validateOperation(program, operation, undefined, messages, entities);
    },
  });
}

function validateServers(
  program: Program,
  service: Namespace,
  channels: readonly ChannelTarget[],
): void {
  const servers = getServers(program, service);
  const usedNames = new Set<string>();
  for (const target of channels) {
    if (!channelProfile(program, target)) continue;
    const selected = getUsedServers(program, target);
    if (selected.length === 0) servers.forEach((server) => usedNames.add(server.name));
    else selected.forEach((server) => usedNames.add(server.name));
  }
  for (const server of servers) {
    if (
      usedNames.has(server.name) &&
      (server.protocol !== "amqps" ||
        (server.protocolVersion !== undefined && server.protocolVersion !== "1.0"))
    ) {
      problem(
        program,
        service,
        "transport-conflict",
        `Server '${server.name}' must use TLS amqps and AMQP protocolVersion 1.0 when specified.`,
      );
    }
  }
  if (usedNames.size > 0) {
    validateBindings(program, service, "server");
    validateSecurity(program, service);
  }
}

function warnDeployment(
  program: Program,
  service: Namespace,
  entities: ReadonlyMap<string, LogicalEntity>,
): void {
  const externalTopics = [...entities.values()].flatMap(({ profile }) =>
    profile.entity.kind === "subscription" && !entities.has(profile.entity.topicId)
      ? [profile.entity.topicId]
      : [],
  );
  const external =
    externalTopics.length > 0
      ? ` External topics: ${[...new Set(externalTopics)].join(", ")}.`
      : "";
  problem(
    program,
    service,
    "deployment-unverified",
    `Service Bus requirements have not been checked against Azure. Composition must verify topology, tier, sessions, partitioning, TTL, settlement settings, TLS, identity and Send/Listen rights.${external} Application code owns metadata, routing and business effects.`,
  );
}

/** Validates only the initial single-service, unversioned application graph. */
export function $onValidate(program: Program): void {
  const messages = listMessages(program);
  const targets = discover(program, messages);
  if (targets.length === 0) return;
  const service = supportedService(program, targets);
  if (!service) return;
  requireProfile(program, service, "info");
  const channels = [...listChannels(program).keys()];
  const entities = topology(program, channels);
  for (const target of targets) {
    const profile = getProfile(program, target);
    if (profile?.target === "message" && target.kind === "Model" && messages.has(target)) {
      validateMessage(program, target, profile);
      validateBindings(program, target, "message");
    }
  }
  validateOperations(program, channels, messages, entities);
  validateServers(program, service, channels);
  warnDeployment(program, service, entities);
}
