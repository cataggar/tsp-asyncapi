import { describe, expect, it } from "vitest";
import { getService, listServices } from "@typespec/compiler";
import { unsafe_mutateSubgraphWithNamespace } from "@typespec/compiler/experimental";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { getSecuritySchemes } from "tsp-asyncapi-core";
import { AsyncAPITester } from "#emitter/testing.js";
import { createServiceDocumentContext } from "#emitter/service-context.js";
import { discoverDocumentDeclarations } from "#emitter/document-context.js";
import { planDocumentOutputs } from "#emitter/document-output.js";
import { buildDocumentFromContext } from "#emitter/pipeline.js";
import { referencesIn } from "../../utils/references.js";
import { resolveRef } from "../../utils/json-pointer.js";
import { byCodePoint } from "../../utils/sort.js";
import type { AsyncAPIDocument } from "#emitter/types/index.js";

describe("Unit: effective service contexts", () => {
  it("keeps service/effective-graph matrices independent of build order and source state", async () => {
    const { program } = await AsyncAPITester.compile(`
      @service @securityScheme("auth", #{ type: "userPassword" })
      @useSecurity("auth") @server("broker", #{ host: "a.example", protocol: "kafka" })
      namespace A {
        @message model Event { alpha: string; }
        @message model Added { added: string; }
        @channel("events") interface Events { @send op publish(event: Event): void; }
      }
      @service @securityScheme("auth", #{ type: "plain" })
      @useSecurity("auth") @server("broker", #{ host: "b.example", protocol: "kafka" })
      namespace B {
        @message model Event { beta: string; }
        @message model Added { added: string; }
        @channel("events") interface Events { @send op publish(event: Event): void; }
      }
    `);
    const services = listServices(program);
    const originalSchemes = getSecuritySchemes(program);
    const matrix = services.flatMap((service) =>
      ["v1", "v2"].map((version) => {
        const graph = unsafe_mutateSubgraphWithNamespace(
          program,
          [
            {
              name: `${service.type.name}-${version}`,
              Namespace(source, clone) {
                if (source === service.type && version === "v1") clone.models.delete("Added");
              },
              Interface: () => undefined,
              Operation: () => undefined,
              Model: () => undefined,
              ModelProperty: () => undefined,
            },
          ],
          service.type,
        );
        if (graph.type.kind !== "Namespace") throw new Error("Expected effective namespace.");
        const document = createServiceDocumentContext(program, service, services, {
          root: graph.type,
          service: getService(program, graph.type),
          declarations: discoverDocumentDeclarations(graph.type),
          ...(graph.realm === null ? {} : { realm: graph.realm }),
        });
        if (document === undefined) throw new Error("Expected a complete live context.");
        return {
          document,
          version,
          multipleServices: true,
          serviceName: document.originalServiceId,
          fileType: "yaml" as const,
          target: graph.type,
        };
      }),
    );
    const planned = planDocumentOutputs(program, "/out", matrix);
    if (planned === undefined) throw new Error("Expected complete output plan.");
    expect(planned.map(({ filename }) => filename)).toEqual([
      "asyncapi.A.v1.yaml",
      "asyncapi.A.v2.yaml",
      "asyncapi.B.v1.yaml",
      "asyncapi.B.v2.yaml",
    ]);
    const built = new Map<string, AsyncAPIDocument>();
    for (const { document, filename } of planned) {
      expect(document.program).toBe(program);
      const doc = await buildDocumentFromContext(document, {});
      built.set(filename, doc);
      const name = document.originalService?.type.name;
      expect(JSON.stringify(doc)).not.toContain(name === "A" ? '"beta"' : '"alpha"');
      expect(Object.keys(doc.components?.messages ?? {}).sort(byCodePoint)).toEqual(
        filename.includes("v1") ? ["Event"] : ["Added", "Event"],
      );
      expect(doc.components?.securitySchemes?.auth).toEqual({
        type: name === "A" ? "userPassword" : "plain",
      });
      expect(doc.servers?.broker.security).toEqual([{ $ref: "#/components/securitySchemes/auth" }]);
      for (const ref of referencesIn(doc)) expect(resolveRef(doc, ref)).toBeDefined();
    }
    for (const { document, filename } of [...planned].reverse()) {
      expect(await buildDocumentFromContext(document, {})).toEqual(built.get(filename));
    }
    expect(getSecuritySchemes(program)).toEqual(originalSchemes);
    expect(originalSchemes).toHaveLength(2);
    for (const service of services) expect(service.type.models.has("Added")).toBe(true);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("scope discovery does not consume the document-local unsupported-signature diagnostic", async () => {
    const { program } = await AsyncAPITester.compile(`
      @service namespace A {
        @message model Event { id: string; }
        @channel("events") interface Events { @send op publish(event: [Event]): void; }
      }
      @service namespace B {}
    `);
    const services = listServices(program);
    const context = createServiceDocumentContext(program, services[0], services);
    if (context === undefined) throw new Error("Expected an original context.");
    expectDiagnosticEmpty(program.diagnostics);
    for (const count of [1, 2]) {
      await buildDocumentFromContext(context, {});
      expect(
        program.diagnostics.filter(
          ({ code }) => code === "tsp-asyncapi/unsupported-operation-message-type",
        ),
      ).toHaveLength(count);
    }
  });
});
