namespace Orders.Public;

// Inert composition values, never credentials or a discovered deployment.
const httpUrl = "https://orders.example.invalid";
const brokerHost = "servicebus.example.invalid";
const commandQueue = "example-order-commands";
const replyQueue = "example-order-replies";
const eventTopic = "example-order-events";
const subscriptionPath = "example-order-events/Subscriptions/example-fulfillment";
const authorization = #{ tls: true, authentication: "entraId" };
