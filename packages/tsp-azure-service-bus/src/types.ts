/**
 * Profile version, independent of the application and package versions.
 * @public
 */
export type ProfileVersion = "0.1.0";

/** Supported logical entity kinds. @public */
export type EntityKind = "queue" | "topic" | "subscription";

/** Supported Azure deployment tiers. @public */
export type ServiceBusTier = "basic" | "standard" | "premium";

/** Optional intent classification, not a restriction on entity kind. @public */
export type MessageKind = "command" | "event" | "reply";

/** Action relative to the described application, matching standard AsyncAPI action. @public */
export type OperationAction = "send" | "receive";

/** Primary receive mode; no delivery mode is implied by omission. @public */
export type ReceiveMode = "peekLock" | "receiveAndDelete";

/** Logical queue; a queue cannot declare a parent topic. @public */
export interface QueueEntity {
  readonly kind: "queue";
  /** Logical catalog ID: `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`, at most 128 characters. */
  readonly id: string;
  readonly topicId?: never;
}

/** Logical topic; a topic cannot declare a parent topic. @public */
export interface TopicEntity {
  readonly kind: "topic";
  /** Logical catalog ID: `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`, at most 128 characters. */
  readonly id: string;
  readonly topicId?: never;
}

/** Logical subscription whose parent may be external to this application. @public */
export interface SubscriptionEntity {
  readonly kind: "subscription";
  /** Logical catalog ID: `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`, at most 128 characters. */
  readonly id: string;
  /** Same ID pattern/128-character limit; must differ from id and name a topic if local. */
  readonly topicId: string;
}

/** Logical topology; aliases must declare compatible requirements. @public */
export type Entity = QueueEntity | TopicEntity | SubscriptionEntity;

/** Nonpartitioned queue/topic ingress duplicate detection, not business idempotency. @public */
export interface DuplicateDetection {
  readonly required: true;
  readonly scope: "messageId";
  /** Exact history window in whole seconds, integer 20..604800 inclusive. */
  readonly historyWindowSeconds?: number;
}

/**
 * Nonempty collection of deployment requirements, not observed Azure facts.
 * Entity-specific applicability and compatibility are validated at runtime.
 * @public
 */
export interface DeploymentRequirements {
  /** Nonempty, unique tier list; every listed tier must support the requirements. */
  readonly allowedTiers?: readonly ServiceBusTier[];
  /** Queue/subscription only; require exactly enabled or disabled. */
  readonly sessions?: boolean;
  /** Queue/topic only; required when duplicateDetection is present. */
  readonly partitioning?: "disabled";
  /** Queue/topic only; requires explicit partitioning: "disabled". */
  readonly duplicateDetection?: DuplicateDetection;
  /** Queue/subscription only; exact whole seconds, integer 1..300 inclusive. */
  readonly lockDurationSeconds?: number;
  /** Queue/subscription only; exact broker delivery limit, integer 1..2147483647. */
  readonly maxDeliveryCount?: number;
  /** Exact entity default/ceiling TTL in whole seconds, integer 1..2147483647. */
  readonly defaultTtlSeconds?: number;
  /** Queue/subscription only; exact deployment requirement. */
  readonly deadLetterOnExpiration?: boolean;
}

/** Constraints on nonempty native string values; no extraction or generation. @public */
export interface NativeString {
  /** False means optional, not forbidden; constraints still apply if present. */
  readonly required: boolean;
  /** Nonempty string, no longer than maxLength when supplied. */
  readonly const?: string;
  /** Positive integer; no profile-imposed upper bound for CorrelationId/Subject. */
  readonly maxLength?: number;
}

/** Native identifier string with an effective maximum of 128 characters. @public */
export interface NativeId {
  readonly required: boolean;
  /** Nonempty string, at most 128 characters and no longer than maxLength. */
  readonly const?: string;
  /** Integer 1..128 inclusive; omission retains the 128-character ceiling. */
  readonly maxLength?: number;
}

/** Native ReplyTo routing address; composition/application supplies the value. @public */
export interface NativeAddress {
  readonly required: boolean;
}

/** Value comes exclusively from explicit standard message contentType. @public */
export interface NativeContentType {
  readonly required: true;
}

/**
 * Nonempty native metadata declaration. Keys have fixed AMQP 1.0 locations;
 * none is an application property or an author-selectable mapping.
 * @public
 */
export interface NativeProperties {
  /** properties/message-id; effective maximum 128 characters. */
  readonly MessageId?: NativeId;
  /** properties/correlation-id; no profile-imposed length ceiling. */
  readonly CorrelationId?: NativeString;
  /** properties/group-id; effective maximum 128 characters. */
  readonly SessionId?: NativeId;
  /** properties/reply-to; requiredness only, no literal address. */
  readonly ReplyTo?: NativeAddress;
  /** properties/reply-to-group-id; effective maximum 128 characters. */
  readonly ReplyToSessionId?: NativeId;
  /** properties/subject; no profile-imposed length ceiling. */
  readonly Subject?: NativeString;
  /** properties/content-type; requires explicit standard message contentType. */
  readonly ContentType?: NativeContentType;
}

/** Primary receive only, never an implicit receive policy for replies. @public */
export interface DeliveryRequirements {
  readonly receiveMode: ReceiveMode;
  /** Requires PeekLock, serial processing, sessions enabled and required SessionId. */
  readonly order?: "perSession";
}

/**
 * Nonempty application obligations, not generated SDK behavior.
 * messageIdentity is send-only; every other field is receive-only.
 * Declaring a receive mode makes its conditional obligations mandatory.
 * @public
 */
export interface ApplicationObligations {
  /** Send only; requires native MessageId on each sent message. */
  readonly messageIdentity?: "uniquePerMessageStableOnRetry";
  /** Required with PeekLock; application owns durable duplicate-effect handling. */
  readonly idempotency?: "required";
  /** PeekLock only; complete only after successful effects. */
  readonly settlement?: "completeAfterSuccess";
  /** PeekLock only; uncertain settlement is not proof of completion. */
  readonly lockLoss?: "treatAsUnsettled";
  /** First value for PeekLock; second for ReceiveAndDelete. */
  readonly failureHandling?: "abandonTransientDeadLetterPermanent" | "applicationRecovery";
  /** Required with ReceiveAndDelete; forbidden with PeekLock. */
  readonly loss?: "accepted";
  /** Requires and is required by perSession order. */
  readonly sessionProcessing?: "serial";
  /** Explicit treatment of delivered/locked messages past their application deadline. */
  readonly expiry?: "checkApplicationDeadline" | "processIfDelivered";
  /** Not legal with ReceiveAndDelete; no automatic cleanup or replay. */
  readonly deadLetter?: "inspectAndRemediate";
}

/** All profile transport is TLS; omission does not make TLS optional. @public */
export interface AuthorizationRequirements {
  readonly tls: true;
  /** Credential acquisition, identity, and data-plane rights remain external. */
  readonly authentication?: "entraId" | "sas";
}

/**
 * Requires standard reply.channel and nonempty reply.messages to a queue.
 * Standard reply.address must be absent; applications implement these relations.
 * @public
 */
export interface NativeReply {
  /** requestReplyTo requires native ReplyTo and a null-address logical reply queue. */
  readonly address: "fixedChannel" | "requestReplyTo";
  /** Copy required request MessageId to required reply CorrelationId. */
  readonly correlation: "requestMessageId";
  /** Copy required request ReplyToSessionId to required reply SessionId on a session queue. */
  readonly session?: "requestReplyToSessionId";
}

/** Required service-level declaration for a profile-bearing application. @public */
export interface InfoProfile {
  readonly profileVersion: ProfileVersion;
  readonly target: "info";
  readonly asyncapiVersion: "3.1.0";
}

/** Composite channel config; physical addresses remain standard channel fields. @public */
export interface ChannelProfile {
  readonly profileVersion: ProfileVersion;
  readonly target: "channel";
  readonly entity: Entity;
  readonly deploymentRequirements?: DeploymentRequirements;
}

/** Composite config for an explicitly marked AsyncAPI message model. @public */
export interface MessageProfile {
  readonly profileVersion: ProfileVersion;
  readonly target: "message";
  readonly messageKind?: MessageKind;
  readonly nativeProperties?: NativeProperties;
  /** Exact producer TTL, integer 1..4294967 seconds; maps to header/ttl milliseconds. */
  readonly ttlSeconds?: number;
}

/**
 * Composite operation config. Conditional rules, including action-specific
 * fields and complete receive obligations, are checked against the normative
 * schema at runtime; TypeScript shapes alone do not prove conformance.
 * @public
 */
export interface OperationProfile {
  readonly profileVersion: ProfileVersion;
  readonly target: "operation";
  /** Required and equal to the existing standard `@send`/`@receive` action. */
  readonly action: OperationAction;
  /** Receive only; omission does not select a default mode. */
  readonly deliveryRequirements?: DeliveryRequirements;
  readonly applicationObligations?: ApplicationObligations;
  readonly authorizationRequirements?: AuthorizationRequirements;
  readonly nativeReply?: NativeReply;
}

/**
 * One closed x-azure-service-bus extension value, never a whole AsyncAPI document.
 * Unknown fields, numeric/string bounds, placement, and cross-object conditions
 * require schema and source validation; no defaults or deep merge are implied.
 * @public
 */
export type ServiceBusProfile = InfoProfile | ChannelProfile | MessageProfile | OperationProfile;
