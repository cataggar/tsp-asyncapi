import "@typespec/http";
import "@typespec/openapi";
import "../domain/order.tsp";
import "../environments/public.tsp";

using TypeSpec.Http;
using TypeSpec.OpenAPI;
using Orders.Domain;

@service(#{ title: "Order Gateway HTTP" })
@info(#{ version: "1.0.0" })
@server(Orders.Public.httpUrl, "Inert public placeholder; bearer audience and identity are external configuration.")
@useAuth(BearerAuth)
namespace OrderHttp;

model SubmissionReceipt {
  @format("uuid")
  commandId: string;
  @format("uuid")
  orderId: string;
  state: "pending";
}

model SubmissionStatus {
  @format("uuid")
  commandId: string;
  @format("uuid")
  orderId: string;
  state: "pending" | "accepted" | "rejected";
  reason?: string;
}

model Problem {
  code: string;
  message: string;
}

@error
model NotFound {
  @statusCode statusCode: 404;
  @body body: Problem;
}

@error
model IdempotencyConflict {
  @statusCode statusCode: 409;
  @body body: Problem;
}

/** 202 records submission intent, not successful order processing or fulfillment. */
@route("/orders")
@post
@operationId("submitOrder")
op submitOrder(
  @header("Idempotency-Key") @format("uuid") commandId: string,
  @body order: Order,
): {
  @statusCode statusCode: 202;
  @header("Location") location: string;
  @body receipt: SubmissionReceipt;
} | IdempotencyConflict;

@route("/orders/{orderId}")
@get
@operationId("getOrder")
op getOrder(@path @format("uuid") orderId: string): Order | NotFound;

@route("/order-submissions/{commandId}")
@get
@operationId("getSubmission")
op getSubmission(@path @format("uuid") commandId: string): SubmissionStatus | NotFound;
