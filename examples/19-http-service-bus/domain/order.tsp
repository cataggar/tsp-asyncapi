namespace Orders.Domain;

/** Shared business data: no HTTP, AsyncAPI, or Service Bus annotations. */
model Order {
  @format("uuid")
  orderId: string;

  @minLength(1)
  customerId: string;

  @minItems(1)
  items: OrderLine[];
}

model OrderLine {
  @minLength(1)
  sku: string;

  @minValue(1)
  @maxValue(1000)
  quantity: int32;
}
