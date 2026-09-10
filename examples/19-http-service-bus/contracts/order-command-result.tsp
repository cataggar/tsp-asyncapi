import "tsp-asyncapi";
import "tsp-azure-service-bus";
import "./application-properties.tsp";

using AsyncAPI;
using Azure.ServiceBus;

namespace Orders.Contracts;

@message
@contentType("application/json")
@headers(ApplicationProperties)
@messageProfile(#{
  profileVersion: "0.1.0",
  target: "message",
  messageKind: "reply",
  nativeProperties: #{
    MessageId: #{ required: true },
    CorrelationId: #{ required: true },
    SessionId: #{ required: true },
    Subject: #{ required: true, `const`: "order.result" },
    ContentType: #{ required: true },
  },
  ttlSeconds: 3600,
})
model OrderCommandResult {
  @format("uuid")
  commandId: string;

  @format("uuid")
  orderId: string;

  outcome: "accepted" | "rejected";
  reason?: string;
  expiresAt: utcDateTime;
}
