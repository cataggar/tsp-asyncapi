import "tsp-asyncapi";
import "tsp-azure-service-bus";
import "../contracts/order-placed.tsp";
import "../contracts/profiles.tsp";
import "../environments/public.tsp";

using AsyncAPI;
using Azure.ServiceBus;
using Orders.Contracts;

@service(#{ title: "Order Fulfillment" })
@info(#{ version: "1.0.0", description: "Consumes the fulfillment subscription, not the publisher's topic endpoint." })
@infoProfile(Orders.Profiles.info)
@server("service-bus", #{ host: Orders.Public.brokerHost, protocol: "amqps", protocolVersion: "1.0" })
namespace OrderFulfillment;

@channel(Orders.Public.subscriptionPath, "fulfillment")
@channelProfile(Orders.Profiles.fulfillment)
@useServer("service-bus")
interface Subscription {
  @receive
  @operationProfile(#{
    profileVersion: "0.1.0", target: "operation", action: "receive",
    deliveryRequirements: Orders.Profiles.delivery,
    applicationObligations: Orders.Profiles.receiveObligations,
    authorizationRequirements: Orders.Public.authorization,
  })
  op onOrderPlaced(): OrderPlaced;
}
