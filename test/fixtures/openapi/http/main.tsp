import "@typespec/http";
import "@typespec/openapi";

using TypeSpec.Http;
using TypeSpec.OpenAPI;

@service(#{ title: "HTTP validation fixture" })
@server("https://api.example.invalid", "An inert public placeholder.")
@useAuth(BearerAuth)
namespace HttpValidation;

model Widget {
  @format("uuid")
  id: string;

  @minLength(1)
  name: string;

  @minValue(1)
  quantity: int32;
}

@route("/widgets")
@post
@operationId("createWidget")
op createWidget(@body body: Widget): {
  @statusCode statusCode: 201;
  @body body: Widget;
};
