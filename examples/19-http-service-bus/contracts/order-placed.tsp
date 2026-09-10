import "tsp-asyncapi";
import "tsp-azure-service-bus";
import "../domain/order.tsp";
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
  messageKind: "event",
  nativeProperties: #{
    MessageId: #{ required: true },
    CorrelationId: #{ required: true },
    SessionId: #{ required: true },
    Subject: #{ required: true, `const`: "order.placed" },
    ContentType: #{ required: true },
  },
  ttlSeconds: 3600,
})
model OrderPlaced {
  @format("uuid")
  eventId: string;

  occurredAt: utcDateTime;
  expiresAt: utcDateTime;
  order: Orders.Domain.Order;
}
