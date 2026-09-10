import "tsp-asyncapi";
import "tsp-azure-service-bus";
import "../contracts/place-order.tsp";
import "../contracts/order-command-result.tsp";
import "../contracts/order-placed.tsp";
import "../contracts/profiles.tsp";
import "../environments/public.tsp";

using AsyncAPI;
using Azure.ServiceBus;
using Orders.Contracts;

@service(#{ title: "Order Processor" })
@info(#{ version: "1.0.0", description: "Receives order commands, sends results, and publishes accepted orders." })
@infoProfile(Orders.Profiles.info)
@server("service-bus", #{ host: Orders.Public.brokerHost, protocol: "amqps", protocolVersion: "1.0" })
namespace OrderProcessor;

@channel(Orders.Public.commandQueue, "commands")
@channelProfile(Orders.Profiles.commands)
@useServer("service-bus")
interface Commands {
  // Receive signatures invert: return = request received; parameter = reply sent.
  @receive
  @replyChannel(Replies)
  @operationProfile(#{
    profileVersion: "0.1.0", target: "operation", action: "receive",
    deliveryRequirements: Orders.Profiles.delivery,
    applicationObligations: Orders.Profiles.receiveObligations,
    authorizationRequirements: Orders.Public.authorization,
    nativeReply: Orders.Profiles.reply,
  })
  op processOrder(result: OrderCommandResult): PlaceOrder;
}

@channel(Orders.Public.replyQueue, "replies")
@channelProfile(Orders.Profiles.replies)
@useServer("service-bus")
interface Replies {
  // The same reply leg, not a second result. Declare its stable retry identity.
  @send
  @operationProfile(#{
    profileVersion: "0.1.0", target: "operation", action: "send",
    applicationObligations: Orders.Profiles.sendObligations,
    authorizationRequirements: Orders.Public.authorization,
  })
  op sendResult(result: OrderCommandResult): void;
}

@channel(Orders.Public.eventTopic, "events")
@channelProfile(Orders.Profiles.events)
@useServer("service-bus")
interface Events {
  @send
  @operationProfile(#{
    profileVersion: "0.1.0", target: "operation", action: "send",
    applicationObligations: Orders.Profiles.sendObligations,
    authorizationRequirements: Orders.Public.authorization,
  })
  op publishOrderPlaced(event: OrderPlaced): void;
}
