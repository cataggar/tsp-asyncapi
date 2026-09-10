import { describe, expect, it } from "vitest";
import { getService, listServices, type Namespace, type Program } from "@typespec/compiler";
import {
  unsafe_mutateSubgraphWithNamespace,
  type unsafe_MutatorWithNamespace as MutatorWithNamespace,
} from "@typespec/compiler/experimental";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { getSecuritySchemes } from "tsp-asyncapi-core";
import { getSecuritySchemesInternal } from "#core/decorators/security/scheme-state.js";
import { AsyncAPITester } from "#emitter/testing.js";
import { createDocumentContext } from "#emitter/document-context.js";
import { buildDocumentFromContext } from "#emitter/pipeline.js";
import { referencesIn } from "../../utils/references.js";
import { resolveRef } from "../../utils/json-pointer.js";

function cloneGraph(
  program: Program,
  root: Namespace,
  overrides: Partial<MutatorWithNamespace> = {},
) {
  const graph = unsafe_mutateSubgraphWithNamespace(
    program,
    [
      {
        name: "live-document-regression",
        Namespace: () => undefined,
        Interface: () => undefined,
        Operation: () => undefined,
        Model: () => undefined,
        ModelProperty: () => undefined,
        ...overrides,
      },
    ],
    root,
  );
  if (graph.type.kind !== "Namespace") throw new Error("Expected a live namespace.");
  return { root: graph.type, ...(graph.realm === null ? {} : { realm: graph.realm }) };
}

describe("Unit: live document graph regressions", () => {
  it.each([
    {
      name: "inline declaration",
      declaration: '@securityScheme("auth", #{ type: "userPassword" })',
      extra: "",
    },
    {
      name: "augment on a reopened namespace",
      declaration: "",
      extra: 'namespace App {} @@securityScheme(App, "auth", #{ type: "userPassword" });',
    },
  ])("retains security on each cloned namespace for an $name", async ({ declaration, extra }) => {
    const { program } = await AsyncAPITester.compile(`
      @service
      ${declaration}
      @server("broker", #{ host: "broker.example", protocol: "kafka" })
      @useSecurity("auth")
      namespace App {}
      ${extra}
    `);
    const originalService = listServices(program)[0];
    const originalRecords = getSecuritySchemesInternal(program, originalService.type);
    const originalSchemes = getSecuritySchemes(program);
    const sourceContext = createDocumentContext(program, originalService, {
      root: originalService.type,
      service: originalService,
    });
    const originalDoc = await buildDocumentFromContext(sourceContext, {});
    const contexts = [0, 1].map(() => {
      const graph = cloneGraph(program, originalService.type);
      return createDocumentContext(program, originalService, {
        ...graph,
        service: getService(program, graph.root),
      });
    });

    for (const context of [...contexts, contexts[0]]) {
      const doc = await buildDocumentFromContext(context, {});
      expect(doc.components?.securitySchemes).toEqual({ auth: { type: "userPassword" } });
      expect(doc.servers?.broker.security).toEqual([{ $ref: "#/components/securitySchemes/auth" }]);
      expect(doc).toEqual(originalDoc);
      const records = getSecuritySchemesInternal(program, context.root);
      expect(records).toHaveLength(1);
      expect(records?.[0]).not.toBe(originalRecords?.[0]);
      for (const reference of referencesIn(doc)) expect(resolveRef(doc, reference)).toBeDefined();
    }
    expect(getSecuritySchemesInternal(program, originalService.type)).toBe(originalRecords);
    expect(getSecuritySchemes(program)).toEqual(originalSchemes);
    expect(await buildDocumentFromContext(sourceContext, {})).toEqual(originalDoc);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("does not import op-is provenance models over the effective return type", async () => {
    const { program } = await AsyncAPITester.compile(`
      namespace Shared {
        @message("Event") model OldEvent { legacy: string; }
        op signature(): OldEvent;
      }
      @service namespace App {
        @message("Event") model NewEvent { replacement: string; }
        @channel("events") interface Events {
          @receive op publish is Shared.signature;
        }
      }
    `);
    const originalService = listServices(program)[0];
    const replacement = originalService.type.models.get("NewEvent");
    if (replacement === undefined) throw new Error("Missing replacement model.");
    const sourceOperation = originalService.type.interfaces
      .get("Events")
      ?.operations.get("publish");
    const originalReturn = sourceOperation?.returnType;
    const graph = cloneGraph(program, originalService.type, {
      Operation(source, clone) {
        if (source === sourceOperation) clone.returnType = replacement;
      },
    });
    const service = getService(program, graph.root);
    const events = graph.root.interfaces.get("Events");
    const publish = events?.operations.get("publish");
    const newEvent = graph.root.models.get("NewEvent");
    if (events === undefined || publish === undefined || newEvent === undefined) {
      throw new Error("Missing live declarations.");
    }
    const selected = createDocumentContext(program, originalService, {
      ...graph,
      service,
      declarations: {
        models: [newEvent],
        channels: [graph.root, events],
        operations: [publish],
        namespaces: [graph.root],
        diagnosticTargets: new Set([graph.root, events, publish, newEvent]),
      },
    });
    const automatic = createDocumentContext(program, originalService, { ...graph, service });
    const control = await buildDocumentFromContext(selected, {});
    const doc = await buildDocumentFromContext(automatic, {});

    expect(automatic.declarations?.operations).toEqual([publish]);
    expect(automatic.artifactInput.models).toEqual([newEvent]);
    expect(doc).toEqual(control);
    expect(Object.keys(doc.channels?.events.messages ?? {})).toEqual(["Event"]);
    expect(JSON.stringify(doc)).toContain('"replacement"');
    expect(JSON.stringify(doc)).not.toContain('"legacy"');
    expect(sourceOperation?.returnType).toBe(originalReturn);
    expect(publish.sourceOperation?.returnType).toHaveProperty("name", "OldEvent");
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("discovers inherited operations and their actual parameter and return models", async () => {
    const { program } = await AsyncAPITester.compile(`
      namespace Shared {
        @message model Input { input: string; }
        @message model Output { output: string; }
        interface Base {
          @send op publish(event: Input): Output;
        }
      }
      @service namespace App {
        @channel("events") interface Events extends Shared.Base {}
      }
    `);
    const originalService = listServices(program)[0];
    const graph = cloneGraph(program, originalService.type);
    const context = createDocumentContext(program, originalService, {
      ...graph,
      service: getService(program, graph.root),
    });
    const publish = graph.root.interfaces.get("Events")?.operations.get("publish");
    const doc = await buildDocumentFromContext(context, {});

    expect(context.declarations?.operations).toEqual([publish]);
    expect(context.artifactInput.models.map((model) => model.name)).toEqual(["Input", "Output"]);
    expect(Object.keys(doc.components?.messages ?? {})).toEqual(["Input", "Output"]);
    expect(Object.keys(doc.channels?.events.messages ?? {})).toEqual(["Input", "Output"]);
    expect(Object.values(doc.operations ?? {})).toHaveLength(1);
    for (const reference of referencesIn(doc)) expect(resolveRef(doc, reference)).toBeDefined();
    expectDiagnosticEmpty(program.diagnostics);
  });
});
