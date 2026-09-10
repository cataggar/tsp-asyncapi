import { createTester } from "@typespec/compiler/testing";
import { fileURLToPath } from "node:url";
import { emitDocumentsWithDiagnostics } from "./test-host.js";

export const VersioningTester = createTester(fileURLToPath(new URL("../../", import.meta.url)), {
  libraries: [
    "tsp-asyncapi",
    "tsp-asyncapi-core",
    "@typespec/versioning",
    "tsp-avro",
    "@typespec/protobuf",
    "@typespec/http",
  ],
})
  .import("tsp-asyncapi", "@typespec/versioning")
  .using("AsyncAPI", "TypeSpec.Versioning");

export function emitVersioned(code: string, options: Record<string, unknown> = {}) {
  return emitDocumentsWithDiagnostics(code, options, false, VersioningTester);
}

/** Shared with retained-message evolution tests; the two shapes never coexist. */
export const retainedMessageVersions = `
  @service @versioned(Versions) namespace App {
    enum Versions { v1: "1.0", v2: "2.0" }
    @message model Event {
      @removed(Versions.v2) legacy: string;
      @added(Versions.v2) replacement: string;
    }
    @channel("events") interface Events {
      @send op publish(event: Event): void;
    }
  }
`;
