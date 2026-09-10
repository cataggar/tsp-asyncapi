import { describe, expect, it } from "vitest";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { emitDocumentsWithDiagnostics } from "../utils/test-host.js";

describe("Integration: service security visibility", () => {
  it("imports only explicitly used shared names, leaving unrelated shared declarations out", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(`
      @securityScheme("auth", #{ type: "userPassword" })
      @securityScheme("unused", #{ type: "plain" })
      namespace Shared {}
      @service @useSecurity("auth")
      @server("broker", #{ host: "a.example", protocol: "kafka" })
      namespace A {}
      @service namespace B {}
    `);
    expectDiagnosticEmpty(diagnostics);
    expect(documents["asyncapi.A.yaml"].components?.securitySchemes).toEqual({
      auth: { type: "userPassword" },
    });
    expect(documents["asyncapi.B.yaml"].components?.securitySchemes).toBeUndefined();
  });

  it("retains unused owned schemes", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(`
      @service @securityScheme("auth", #{ type: "userPassword" }) namespace A {}
      @service @securityScheme("auth", #{ type: "plain" }) namespace B {}
    `);
    expectDiagnosticEmpty(diagnostics);
    expect(documents["asyncapi.A.yaml"].components?.securitySchemes?.auth).toEqual({
      type: "userPassword",
    });
    expect(documents["asyncapi.B.yaml"].components?.securitySchemes?.auth).toEqual({
      type: "plain",
    });
  });

  it.each([
    '@securityScheme("auth", #{ type: "plain" }) namespace OtherShared {}',
    '@@securityScheme(A, "auth", #{ type: "plain" });',
  ])("refuses ambiguous visible definitions without shadowing: %s", async (other) => {
    const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(`
      @securityScheme("auth", #{ type: "userPassword" }) namespace Shared {}
      @service @useSecurity("auth")
      @server("broker", #{ host: "a.example", protocol: "kafka" }) namespace A {}
      @service namespace B {}
      ${other}
    `);
    expect(outputs).toEqual({});
    expect(diagnostics.map(({ code }) => code)).toContain("tsp-asyncapi/ambiguous-security-scheme");
  });

  it("does not diagnose unused ambiguous shared schemes", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(`
      @securityScheme("auth", #{ type: "userPassword" }) namespace Shared {}
      @securityScheme("auth", #{ type: "plain" }) namespace OtherShared {}
      @service namespace A {} @service namespace B {}
    `);
    expectDiagnosticEmpty(diagnostics);
    for (const doc of Object.values(documents))
      expect(doc.components?.securitySchemes).toBeUndefined();
  });

  it("does not resolve another application's same-name definition", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(
      `
      @service @securityScheme("auth", #{ type: "userPassword" }) namespace A {}
      @service @useSecurity("auth")
      @server("broker", #{ host: "b.example", protocol: "kafka" }) namespace B {}
    `,
      { service: "B" },
    );
    expect(diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/undeclared-security-scheme",
    );
    expect(documents["asyncapi.B.yaml"].components?.securitySchemes).toBeUndefined();
    expect(documents["asyncapi.B.yaml"].servers?.broker.security).toBeUndefined();
  });

  it("rejects duplicates inside one service even when a selector excludes it", async () => {
    const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(
      `
      @service @securityScheme("auth", #{ type: "plain" }) namespace A {
        @securityScheme("auth", #{ type: "userPassword" }) namespace Nested {}
      }
      @service namespace B {}
    `,
      { service: "B" },
    );
    expect(outputs).toEqual({});
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "tsp-asyncapi/duplicate-security-scheme-name",
    ]);
  });
});
