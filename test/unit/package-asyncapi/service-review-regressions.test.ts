import { describe, expect, it } from "vitest";
import { getService, listServices, type Program, type Service } from "@typespec/compiler";
import {
  unsafe_mutateSubgraphWithNamespace,
  type unsafe_MutatorWithNamespace as Mutator,
} from "@typespec/compiler/experimental";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { AsyncAPITester } from "#emitter/testing.js";
import { createServiceDocumentContext } from "#emitter/service-context.js";
import { discoverDocumentDeclarations, type DocumentContext } from "#emitter/document-context.js";
import { buildDocumentFromContext } from "#emitter/pipeline.js";
import { emitDocumentsWithDiagnostics } from "../../utils/test-host.js";
import { referencesIn } from "../../utils/references.js";
import { resolveRef } from "../../utils/json-pointer.js";

function requiredContext(
  ...args: Parameters<typeof createServiceDocumentContext>
): DocumentContext {
  const context = createServiceDocumentContext(...args);
  if (context === undefined) throw new Error("The test requires a complete document context.");
  return context;
}

const ALIASES = `
  @service(#{ title: "App" }) namespace App {
    @message model Event { id: string; }
    @message model Unused<T> { value: T; }
    @channel("events") interface Channel<T> { @send op publish(event: T): void; }
    alias Endpoint = Channel<Event>;
    alias Message = Unused<string>;
  }
`;

function cloneAliases(
  program: Program,
  service: Service,
  context: DocumentContext,
  includeAliases: boolean,
  change = false,
) {
  const unused = context.declarations?.models.find(
    (model) => model.name === "Unused" && model.templateMapper !== undefined,
  );
  const channel = context.declarations?.channels.find(
    (type) => type.kind === "Interface" && type.name === "Channel",
  );
  if (unused === undefined || channel?.kind !== "Interface") {
    throw new Error("Missing original alias instances.");
  }
  const publish = channel.operations.get("publish");
  const mutator: Mutator = {
    name: `alias-boundary-${String(includeAliases)}-${String(change)}`,
    Namespace(source, clone) {
      if (source !== service.type || !includeAliases) return;
      // A version adapter must make retained erased roots part of its real
      // mutation traversal, not pass original identities as emitted declarations.
      clone.models.set("AliasMessage", unused);
      clone.interfaces.set("AliasEndpoint", channel);
    },
    Interface: () => undefined,
    Operation(source, clone) {
      if (change && source === publish) clone.name = "currentPublish";
    },
    Model: () => undefined,
    ModelProperty(source, clone) {
      if (change && source.model === unused) clone.optional = true;
    },
  };
  const result = unsafe_mutateSubgraphWithNamespace(program, [mutator], service.type);
  if (result.type.kind !== "Namespace") throw new Error("Expected a mutated namespace.");
  return {
    root: result.type,
    service: getService(program, result.type),
    ...(result.realm === null ? {} : { realm: result.realm }),
  };
}

describe("Review: service ownership reachability", () => {
  it.each(["payload", "headers", "transitive subtype"])(
    "refuses foreign discriminator-reachable envelopes through %s before any output",
    async (position) => {
      const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(
        `
        namespace Shared {
          @discriminator("kind") model Base { kind: string; }
          ${position === "transitive subtype" ? "model Middle extends Base {}" : ""}
        }
        @service namespace A {
          ${position === "headers" ? "@headers(Shared.Base)" : ""}
          @message model Event { ${position === "headers" ? "id: string;" : "value: Shared.Base;"} }
        }
        @service namespace B {
          @message model Foreign extends Shared.${position === "transitive subtype" ? "Middle" : "Base"} {
            kind: "foreign"; onlyB: string;
          }
        }
      `,
        { ...(position === "payload" ? {} : { service: "A" }), "file-type": "json" },
      );
      expect(outputs).toEqual({});
      expect(diagnostics.map(({ code }) => code)).toContain("tsp-asyncapi/cross-service-reference");
    },
  );

  it("preserves shared undecorated discriminator subtypes, including foreign domain data", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(
      `
      namespace Shared {
        @discriminator("kind") model Base { kind: string; }
        model Middle extends Base {}
        model Local extends Middle { kind: "local"; common: string; }
      }
      @service namespace A { @message model Event { value: Shared.Base; } }
      @service @extension("x-app", "B") namespace B {
        model Domain extends Shared.Base { kind: "domain"; data: string; }
      }
    `,
      { service: "A" },
    );
    expectDiagnosticEmpty(diagnostics);
    const doc = documents["asyncapi.A.yaml"];
    expect(JSON.stringify(doc)).toContain("common");
    expect(JSON.stringify(doc)).toContain('"data"');
    expect(JSON.stringify(doc)).not.toContain("x-app");
    for (const ref of referencesIn(doc)) expect(resolveRef(doc, ref)).toBeDefined();
  });

  it("does not follow undiscriminated derived types that lowering leaves out", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(
      `
      namespace Shared { model Base { id: string; } }
      @service namespace A { @message model Event { value: Shared.Base; } }
      @service namespace B { @message model Foreign extends Shared.Base { onlyB: string; } }
    `,
      { service: "A" },
    );
    expectDiagnosticEmpty(diagnostics);
    expect(JSON.stringify(documents["asyncapi.A.yaml"])).not.toContain("onlyB");
  });
});

describe("Review: erased action instances", () => {
  it("rejects an unowned finished aliased action in a multi-service program", async () => {
    const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(`
      @service namespace A {} @service namespace B {}
      @send op outside<T>(x: T): void;
      alias Realized = outside<string>;
    `);
    expect(outputs).toEqual({});
    expect(diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/unowned-application-declaration",
    );
  });

  it("emits an owned aliased action with its namespace channel messages", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(`
      @service @channel("events") namespace A {
        @message model Event { id: string; }
        @send op publish<T>(x: T): void;
        alias Realized = publish<Event>;
      }
      @service namespace B {}
    `);
    expectDiagnosticEmpty(diagnostics);
    const doc = documents["asyncapi.A.yaml"];
    expect(Object.keys(doc.operations ?? {})).toEqual(["publish"]);
    expect(Object.keys(doc.channels?.events.messages ?? {})).toEqual(["Event"]);
    for (const ref of referencesIn(doc)) expect(resolveRef(doc, ref)).toBeDefined();
    await expect(doc).toBeValidAsyncAPI();
  });

  it("retains the existing diagnostic for owned aliased actions without a channel", async () => {
    const { diagnostics } = await emitDocumentsWithDiagnostics(`
      @service namespace A {
        @send op outside<T>(x: T): void;
        alias Realized = outside<string>;
      }
      @service namespace B {}
    `);
    expect(diagnostics.map(({ code }) => code)).toContain("tsp-asyncapi/operation-without-channel");
  });

  it.each([false, true])(
    "exempts exact source carriers, not unrelated instances (extra=%s)",
    async (extra) => {
      const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(`
      namespace Shared {
        @message model Event { id: string; }
        @send op carrier<T>(event: T): void;
        ${extra ? "alias Unowned = carrier<string>;" : ""}
      }
      @service namespace A {
        @channel("events") interface Events { op publish is Shared.carrier<Shared.Event>; }
      }
      @service namespace B {}
    `);
      if (extra) {
        expect(outputs).toEqual({});
        expect(diagnostics.map(({ code }) => code)).toContain(
          "tsp-asyncapi/unowned-application-declaration",
        );
      } else {
        expectDiagnosticEmpty(diagnostics);
        expect(Object.keys(outputs)).toHaveLength(2);
      }
    },
  );
});

describe("Review: complete effective alias boundaries", () => {
  it("preserves aliases when an explicitly effective graph is the identical original graph", async () => {
    const { program } = await AsyncAPITester.compile(ALIASES);
    const services = listServices(program);
    const original = requiredContext(program, services[0], services);
    const identical = requiredContext(program, services[0], services, {
      root: services[0].type,
      service: services[0],
    });
    const control = await buildDocumentFromContext(original, {});
    expect(Object.keys(control.channels ?? {})).toEqual(["events"]);
    expect(Object.keys(control.components?.messages ?? {})).toEqual(["Event", "UnusedString"]);
    expect(await buildDocumentFromContext(identical, {})).toEqual(control);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("explicitly refuses an incomplete no-op mutated graph instead of dropping aliases", async () => {
    const { program } = await AsyncAPITester.compile(ALIASES);
    const services = listServices(program);
    const original = requiredContext(program, services[0], services);
    const graph = cloneAliases(program, services[0], original, false);
    expect(createServiceDocumentContext(program, services[0], services, graph)).toBeUndefined();
    expect(program.diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/incomplete-effective-document",
    );
  });

  it.each([false, true])("accepts genuinely mutated live aliases (changed=%s)", async (change) => {
    const { program } = await AsyncAPITester.compile(ALIASES);
    const services = listServices(program);
    const original = requiredContext(program, services[0], services);
    const control = await buildDocumentFromContext(original, {});
    const graph = cloneAliases(program, services[0], original, true, change);
    const live = requiredContext(program, services[0], services, {
      ...graph,
      declarations: discoverDocumentDeclarations(graph.root),
    });
    const doc = await buildDocumentFromContext(live, {});
    expect(Object.keys(doc.channels ?? {})).toEqual(["events"]);
    expect(Object.keys(doc.components?.messages ?? {})).toEqual(["Event", "UnusedString"]);
    expect(Object.keys(doc.operations ?? {})).toEqual([change ? "currentPublish" : "publish"]);
    if (change) {
      expect(doc.components?.schemas?.UnusedString).not.toHaveProperty("required");
    } else {
      expect(doc).toEqual(control);
    }
    for (const model of live.artifactInput.models) {
      expect(original.artifactInput.models).not.toContain(model);
      expect(model.namespace).toBe(graph.root);
    }
    expect(services[0].type.models.has("AliasMessage")).toBe(false);
    expect(services[0].type.interfaces.has("AliasEndpoint")).toBe(false);
    expect(await buildDocumentFromContext(original, {})).toEqual(control);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("honors explicit removal of erased instances without recovering them from source state", async () => {
    const { program } = await AsyncAPITester.compile(ALIASES);
    const services = listServices(program);
    const original = requiredContext(program, services[0], services);
    const retainedGraph = cloneAliases(program, services[0], original, true);
    const retained = requiredContext(program, services[0], services, {
      ...retainedGraph,
      declarations: discoverDocumentDeclarations(retainedGraph.root),
    });
    const retainedDocument = await buildDocumentFromContext(retained, {});
    // The adapter deliberately retains no erased instances in this snapshot.
    const graph = cloneAliases(program, services[0], original, false);
    const live = requiredContext(program, services[0], services, {
      ...graph,
      declarations: discoverDocumentDeclarations(graph.root),
    });
    const doc = await buildDocumentFromContext(live, {});
    expect(doc.channels).toEqual({});
    expect(Object.keys(doc.components?.messages ?? {})).toEqual(["Event"]);
    expect(original.artifactInput.models).toHaveLength(2);
    expect(await buildDocumentFromContext(retained, {})).toEqual(retainedDocument);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("supports complete live aliased actions after actual signature mutation", async () => {
    const { program } = await AsyncAPITester.compile(`
      @service @channel("events") namespace App {
        @message model Event { id: string; }
        @send op publish<T>(event: T): void;
        alias Realized = publish<Event>;
      }
    `);
    const services = listServices(program);
    const original = requiredContext(program, services[0], services);
    const action = original.declarations?.operations.find(
      (operation) => operation.name === "publish" && operation.templateMapper !== undefined,
    );
    if (action === undefined) throw new Error("Missing source action instance.");
    const graph = unsafe_mutateSubgraphWithNamespace(
      program,
      [
        {
          name: "live-aliased-action",
          Namespace(source, clone) {
            if (source === services[0].type) clone.operations.set("AliasAction", action);
          },
          Operation(source, clone) {
            if (source === action) clone.name = "currentPublish";
          },
          Model: () => undefined,
          ModelProperty: () => undefined,
        },
      ],
      services[0].type,
    );
    if (graph.type.kind !== "Namespace") throw new Error("Expected live namespace.");
    const live = requiredContext(program, services[0], services, {
      root: graph.type,
      service: getService(program, graph.type),
      ...(graph.realm === null ? {} : { realm: graph.realm }),
      declarations: discoverDocumentDeclarations(graph.type),
    });
    const doc = await buildDocumentFromContext(live, {});
    expect(Object.keys(doc.operations ?? {})).toEqual(["currentPublish"]);
    expect(Object.keys(doc.channels?.events.messages ?? {})).toEqual(["Event"]);
    expect(action.name).toBe("publish");
    expect(services[0].type.operations.has("AliasAction")).toBe(false);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("rejects source-owned declaration identities passed as an effective boundary", async () => {
    const { program } = await AsyncAPITester.compile(ALIASES);
    const services = listServices(program);
    const original = requiredContext(program, services[0], services);
    const graph = cloneAliases(program, services[0], original, false);
    expect(
      createServiceDocumentContext(program, services[0], services, {
        ...graph,
        declarations: original.declarations,
      }),
    ).toBeUndefined();
    expect(program.diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/stale-effective-declaration",
    );
  });
});
