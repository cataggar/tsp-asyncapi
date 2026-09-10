namespace Orders.Profiles;

const info = #{ profileVersion: "0.1.0", target: "info", asyncapiVersion: "3.1.0" };

const commands = #{
  profileVersion: "0.1.0",
  target: "channel",
  entity: #{ kind: "queue", id: "orders.commands" },
  deploymentRequirements: #{
    allowedTiers: #["standard", "premium"],
    sessions: true,
    partitioning: "disabled",
    duplicateDetection: #{ required: true, scope: "messageId", historyWindowSeconds: 600 },
    lockDurationSeconds: 30,
    maxDeliveryCount: 10,
    defaultTtlSeconds: 86400,
    deadLetterOnExpiration: true,
  },
};

const replies = #{
  profileVersion: "0.1.0",
  target: "channel",
  entity: #{ kind: "queue", id: "orders.gateway-replies" },
  deploymentRequirements: #{
    allowedTiers: #["standard", "premium"],
    sessions: true,
    partitioning: "disabled",
    duplicateDetection: #{ required: true, scope: "messageId", historyWindowSeconds: 600 },
    lockDurationSeconds: 30,
    maxDeliveryCount: 10,
    defaultTtlSeconds: 86400,
    deadLetterOnExpiration: true,
  },
};

const events = #{
  profileVersion: "0.1.0",
  target: "channel",
  entity: #{ kind: "topic", id: "orders.events" },
  deploymentRequirements: #{
    allowedTiers: #["standard", "premium"],
    partitioning: "disabled",
    duplicateDetection: #{ required: true, scope: "messageId", historyWindowSeconds: 600 },
    defaultTtlSeconds: 86400,
  },
};

const fulfillment = #{
  profileVersion: "0.1.0",
  target: "channel",
  entity: #{ kind: "subscription", id: "orders.fulfillment", topicId: "orders.events" },
  deploymentRequirements: #{
    allowedTiers: #["standard", "premium"],
    sessions: true,
    lockDurationSeconds: 30,
    maxDeliveryCount: 10,
    defaultTtlSeconds: 86400,
    deadLetterOnExpiration: true,
  },
};

const sendObligations = #{ messageIdentity: "uniquePerMessageStableOnRetry" };
const delivery = #{ receiveMode: "peekLock", order: "perSession" };
const receiveObligations = #{
  idempotency: "required",
  settlement: "completeAfterSuccess",
  lockLoss: "treatAsUnsettled",
  failureHandling: "abandonTransientDeadLetterPermanent",
  sessionProcessing: "serial",
  expiry: "checkApplicationDeadline",
  deadLetter: "inspectAndRemediate",
};
const reply = #{
  address: "fixedChannel",
  correlation: "requestMessageId",
  session: "requestReplyToSessionId",
};
