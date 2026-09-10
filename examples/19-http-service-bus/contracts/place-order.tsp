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
  messageKind: "command",
  nativeProperties: #{
    MessageId: #{ required: true },
    CorrelationId: #{ required: true },
    SessionId: #{ required: true },
    ReplyTo: #{ required: true },
    ReplyToSessionId: #{ required: true },
    Subject: #{ required: true, `const`: "order.place" },
    ContentType: #{ required: true },
  },
  ttlSeconds: 3600,
})
model PlaceOrder {
  @format("uuid")
  commandId: string;

  /** An application deadline; broker TTL does not cancel business effects. */
  expiresAt: utcDateTime;

  order: Orders.Domain.Order;
}
