namespace Azure.ServiceBus;

/** Logical catalog identifier, not an Azure resource path or entity-name limit. */
@pattern("^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$")
@maxLength(128)
scalar LogicalId extends string;

alias ProfileVersion = "0.1.0";
alias EntityKind = "queue" | "topic" | "subscription";
alias ServiceBusTier = "basic" | "standard" | "premium";
alias MessageKind = "command" | "event" | "reply";
alias OperationAction = "send" | "receive";
alias ReceiveMode = "peekLock" | "receiveAndDelete";

/** Logical queue with no parent topic. */
model QueueEntity {
  kind: "queue";
  id: LogicalId;
}

/** Logical topic with no parent topic. */
model TopicEntity {
  kind: "topic";
  id: LogicalId;
}

/** A parent may be external; a local parent must be a topic and not this id. */
model SubscriptionEntity {
  kind: "subscription";
  id: LogicalId;
  topicId: LogicalId;
}

alias Entity = QueueEntity | TopicEntity | SubscriptionEntity;

/** Nonpartitioned queue/topic ingress deduplication, not business idempotency. */
model DuplicateDetection {
  required: true;
  scope: "messageId";

  /** Exact history window in whole seconds, integer 20..604800 inclusive. */
  @minValue(20)
  @maxValue(604800)
  historyWindowSeconds?: integer;
}

/** Nonempty requirements, not observed facts; entity applicability is validated separately. */
model DeploymentRequirements {
  /** Nonempty unique tiers; every tier must support all known requirements. */
  @minItems(1)
  allowedTiers?: ServiceBusTier[];

  /** Queue/subscription only; exactly enabled or disabled. */
  sessions?: boolean;

  /** Queue/topic only; required when duplicateDetection is present. */
  partitioning?: "disabled";

  /** Queue/topic only; requires explicit partitioning: "disabled". */
  duplicateDetection?: DuplicateDetection;

  /** Queue/subscription only; exact whole seconds, integer 1..300 inclusive. */
  @minValue(1)
  @maxValue(300)
  lockDurationSeconds?: integer;

  /** Queue/subscription only; broker delivery limit, not SDK/business retries. */
  @minValue(1)
  @maxValue(2147483647)
  maxDeliveryCount?: integer;

  /** Exact entity default/ceiling TTL in whole seconds, integer 1..2147483647. */
  @minValue(1)
  @maxValue(2147483647)
  defaultTtlSeconds?: integer;

  /** Queue/subscription only; exact deployment requirement. */
  deadLetterOnExpiration?: boolean;
}

/** Nonempty native strings, no extraction/generation and no implicit maximum. */
model NativeString {
  /** False means optional, not forbidden; constraints still apply if present. */
  required: boolean;

  /** Must not exceed maxLength when one is supplied. */
  @minLength(1)
  `const`?: string;

  @minValue(1)
  maxLength?: integer;
}

/** Native identifier, with an effective maximum of 128 characters. */
model NativeId {
  required: boolean;

  /** Must also satisfy maxLength when supplied. */
  @minLength(1)
  @maxLength(128)
  `const`?: string;

  @minValue(1)
  @maxValue(128)
  maxLength?: integer;
}

/** ReplyTo address supplied by composition/application, not a profile literal. */
model NativeAddress {
  required: boolean;
}

/** Value comes exclusively from explicit standard message contentType. */
model NativeContentType {
  required: true;
}

/** Nonempty native declarations with fixed AMQP 1.0 locations, not application headers. */
model NativeProperties {
  /** properties/message-id; effective maximum 128 characters. */
  MessageId?: NativeId;

  /** properties/correlation-id; no profile-imposed length ceiling. */
  CorrelationId?: NativeString;

  /** properties/group-id; effective maximum 128 characters. */
  SessionId?: NativeId;

  /** properties/reply-to; requiredness only. */
  ReplyTo?: NativeAddress;

  /** properties/reply-to-group-id; effective maximum 128 characters. */
  ReplyToSessionId?: NativeId;

  /** properties/subject; no profile-imposed length ceiling. */
  Subject?: NativeString;

  /** properties/content-type; requires explicit standard @contentType. */
  ContentType?: NativeContentType;
}

/** Primary receive only, never an implicit policy for receiving replies. */
model DeliveryRequirements {
  receiveMode: ReceiveMode;

  /** Requires PeekLock, serial processing, sessions enabled and required SessionId. */
  order?: "perSession";
}

/** Nonempty obligations; conditional applicability is validated, never defaulted. */
model ApplicationObligations {
  /** Send only; requires MessageId on each sent message. */
  messageIdentity?: "uniquePerMessageStableOnRetry";

  /** Receive only; mandatory with PeekLock. */
  idempotency?: "required";

  /** Receive/PeekLock only. */
  settlement?: "completeAfterSuccess";

  /** Receive/PeekLock only. */
  lockLoss?: "treatAsUnsettled";

  /** Receive only; first value for PeekLock, second for ReceiveAndDelete. */
  failureHandling?: "abandonTransientDeadLetterPermanent" | "applicationRecovery";

  /** ReceiveAndDelete only; mandatory with that mode. */
  loss?: "accepted";

  /** Receive only; requires and is required by perSession order. */
  sessionProcessing?: "serial";

  /** Receive only; treatment of delivered messages past an application deadline. */
  expiry?: "checkApplicationDeadline" | "processIfDelivered";

  /** Receive only; forbidden with ReceiveAndDelete. No automatic cleanup/replay. */
  deadLetter?: "inspectAndRemediate";
}

/** TLS is required throughout the profile, even when this config is omitted. */
model AuthorizationRequirements {
  tls: true;

  /** Identity, credential acquisition and data-plane rights remain external. */
  authentication?: "entraId" | "sas";
}

/** Requires standard reply channel/messages to a queue, with no standard reply.address. */
model NativeReply {
  /** requestReplyTo requires request ReplyTo and a null-address logical reply queue. */
  address: "fixedChannel" | "requestReplyTo";

  /** Application copies required request MessageId to required reply CorrelationId. */
  correlation: "requestMessageId";

  /** Copy request ReplyToSessionId to reply SessionId; reply queue requires sessions. */
  session?: "requestReplyToSessionId";
}

/** Required declaration on the service namespace of a profile-bearing document. */
model InfoProfile {
  profileVersion: ProfileVersion;
  target: "info";
  asyncapiVersion: "3.1.0";
}

/** Composite config on an existing channel; physical address stays a standard field. */
model ChannelProfile {
  profileVersion: ProfileVersion;
  target: "channel";
  entity: Entity;
  deploymentRequirements?: DeploymentRequirements;
}

/** Composite config on a marked message; payload, headers and contentType stay standard. */
model MessageProfile {
  profileVersion: ProfileVersion;
  target: "message";
  messageKind?: MessageKind;
  nativeProperties?: NativeProperties;

  /** Exact producer TTL in seconds; application maps to AMQP header/ttl milliseconds. */
  @minValue(1)
  @maxValue(4294967)
  ttlSeconds?: integer;
}

/** Composite config; schema and source validation enforce closure and conditional rules. */
model OperationProfile {
  profileVersion: ProfileVersion;
  target: "operation";

  /** Required and equal to the standard @send/@receive action. */
  action: OperationAction;

  /** Primary receive only; omission selects no default mode. */
  deliveryRequirements?: DeliveryRequirements;

  applicationObligations?: ApplicationObligations;
  authorizationRequirements?: AuthorizationRequirements;
  nativeReply?: NativeReply;
}

/** One extension value, not a document; these shapes alone do not prove conformance. */
alias ServiceBusProfile = InfoProfile | ChannelProfile | MessageProfile | OperationProfile;
