import "tsp-asyncapi";
import "tsp-azure-service-bus";
import "./contracts/place-order.tsp";
import "./contracts/order-command-result.tsp";
import "./contracts/profiles.tsp";
import "./environments/public.tsp";

using AsyncAPI;
using Azure.ServiceBus;
using Orders.Contracts;

@service(#{ title: "Order Gateway messaging" })
@info(#{ version: "1.0.0", description: "The gateway sends commands and receives results; HTTP is a separate entrypoint." })
@infoProfile(Orders.Profiles.info)
@server("service-bus", #{ host: Orders.Public.brokerHost, protocol: "amqps", protocolVersion: "1.0" })
namespace OrderGateway;

@channel(Orders.Public.commandQueue, "commands")
@channelProfile(Orders.Profiles.commands)
@useServer("service-bus")
interface Commands {
  // Return notation describes an asynchronous reply, not a blocking HTTP call.
  @send
  @replyChannel(Replies)
  @operationProfile(#{
    profileVersion: "0.1.0", target: "operation", action: "send",
    applicationObligations: Orders.Profiles.sendObligations,
    authorizationRequirements: Orders.Public.authorization,
    nativeReply: Orders.Profiles.reply,
  })
  op submitOrder(command: PlaceOrder): OrderCommandResult;
}

@channel(Orders.Public.replyQueue, "replies")
@channelProfile(Orders.Profiles.replies)
@useServer("service-bus")
interface Replies {
  // This is submitOrder's reply leg, with its own receive/settlement obligations.
  @receive
  @operationProfile(#{
    profileVersion: "0.1.0", target: "operation", action: "receive",
    deliveryRequirements: Orders.Profiles.delivery,
    applicationObligations: Orders.Profiles.receiveObligations,
    authorizationRequirements: Orders.Public.authorization,
  })
  op receiveResult(): OrderCommandResult;
}
