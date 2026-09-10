import { describe, expect, it } from "vitest";
import { getService, listServices, type Namespace, type Program } from "@typespec/compiler";
import { unsafe_mutateSubgraphWithNamespace } from "@typespec/compiler/experimental";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { listMessages } from "tsp-asyncapi-core";
import { AsyncAPITester } from "#emitter/testing.js";
import { createDocumentContext, discoverDocumentDeclarations } from "#emitter/document-context.js";
import { buildAsyncAPIDocument, buildDocumentFromContext } from "#emitter/pipeline.js";
import { namespaceOf } from "../../utils/namespace.js";
import { diagnosticsWith } from "../../utils/diagnostics.js";
import { referencesIn } from "../../utils/references.js";
import { resolveRef } from "../../utils/json-pointer.js";

function contextFor(program: Program, root: Namespace) {
  const service = getService(program, root);
  return createDocumentContext(program, service, { root, service });
}

describe("Unit: document contexts", () => {
  it("preserves whole-program declarations and selected metadata on the default path", async () => {
    const { program } = await AsyncAPITester.compile(`
      @message model GlobalEvent { id: string; }
      @service(#{ title: "First" }) namespace First {
        @message model FirstEvent { id: string; }
      }
      @service(#{ title: "Second" }) namespace Second {
        @message model SecondEvent { id: string; }
      }
    `);
    const service = listServices(program)[0];
    const context = createDocumentContext(program, service);
    const doc = await buildDocumentFromContext(context, {});

    expect(context.program).toBe(program);
    expect(context.originalService).toBe(service);
    expect(context.originalServiceId).toBe("First");
    expect(context.root).toBe(program.getGlobalNamespaceType());
    expect(context.declarations).toBeUndefined();
    expect(Object.isFrozen(context)).toBe(true);
    expect(doc.info.title).toBe("First");
    expect(Object.keys(doc.components?.messages ?? {})).toEqual([
      "GlobalEvent",
      "FirstEvent",
      "SecondEvent",
    ]);
    expect(doc).toEqual(await buildAsyncAPIDocument(program, service, {}));
  });

  it("scopes declarations and wrap-up diagnostics before assigning document keys", async () => {
    const { program } = await AsyncAPITester.compile(`
      @service(#{ title: "Selected" })
      @server("selected", #{ host: "selected.example", protocol: "kafka" })
      @securityScheme("selectedAuth", #{ type: "userPassword" })
      namespace Selected {
        @message("Event") model SelectedEvent { id: string; }
        @channel("events") interface Events {
          @send op publish(event: SelectedEvent): void;
        }
      }
      @service(#{ title: "Excluded" })
      @server("excluded", #{ host: "excluded.example", protocol: "kafka" })
      @securityScheme("excludedAuth", #{ type: "userPassword" })
      @useSecurity("excludedAuth")
      namespace Excluded {
        @message("Event") model OtherEvent { id: string; }
        @extension("x-stray", true) model Plain {}
        @kafkaChannel(#{}) interface Unattached {}
        @useServer("excluded") interface Unused {}
        @replyAddress("$message.header#/replyTo") op noAction(): void;
        @send op orphan(event: OtherEvent): void;
      }
    `);
    const doc = await buildDocumentFromContext(
      contextFor(program, namespaceOf(program, "Selected")),
      {},
    );

    expect(Object.keys(doc.components?.messages ?? {})).toEqual(["Event"]);
    expect(Object.keys(doc.channels ?? {})).toEqual(["events"]);
    expect(Object.keys(doc.operations ?? {})).toEqual(["publish"]);
    expect(Object.keys(doc.servers ?? {})).toEqual(["selected"]);
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["selectedAuth"]);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("uses explicit operation identities for both direct membership and reverse replies", async () => {
    const { program } = await AsyncAPITester.compile(`
      @message model Event { id: string; }
      @message model ExcludedReply { id: string; }
      @channel("events") interface Events {
        @send op publish(event: Event): void;
        @send op excluded(event: ExcludedReply, unused: string): void;
      }
      @channel("requests") interface Requests {
        @send @replyChannel(Events) op request(event: Event): ExcludedReply;
      }
    `);
    const root = program.getGlobalNamespaceType();
    const discovered = discoverDocumentDeclarations(root);
    const events = root.interfaces.get("Events");
    if (events === undefined) throw new Error("Missing Events fixture.");
    const selected = discovered.operations.filter((operation) => operation.name === "publish");
    const context = createDocumentContext(program, undefined, {
      root,
      service: undefined,
      declarations: {
        ...discovered,
        channels: [events],
        operations: selected,
        diagnosticTargets: new Set([events, ...selected, ...discovered.models]),
      },
    });
    selected.length = 0;
    const doc = await buildDocumentFromContext(context, {});

    expect(Object.keys(doc.components?.messages ?? {})).toEqual(["Event", "ExcludedReply"]);
    expect(Object.keys(doc.channels?.events.messages ?? {})).toEqual(["Event"]);
    expect(Object.keys(doc.operations ?? {})).toEqual(["publish"]);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("discovers a cloned live root on the original Program without resurrecting removed state", async () => {
    const { program } = await AsyncAPITester.compile(`
      @service(#{ title: "Original" }) namespace App {
        @message model Event { id: string; }
        @message @extension("x-removed", true) model Removed { id: string; }
        @channel("events") interface Events {
          @send op publish(event: Event): void;
        }
      }
    `);
    const service = listServices(program)[0];
    const originalModel = service.type.models.get("Event");
    expect(listMessages(program).size).toBe(2);
    const mutated = unsafe_mutateSubgraphWithNamespace(
      program,
      [
        {
          name: "document-context-fixture",
          Namespace(source, clone) {
            if (source === service.type) clone.models.delete("Removed");
          },
          Model(source, clone) {
            if (source === originalModel) clone.name = "LiveEvent";
          },
          ModelProperty(source, clone) {
            clone.optional = source.optional;
          },
        },
      ],
      service.type,
    );
    if (mutated.type.kind !== "Namespace") throw new Error("Expected a live namespace.");
    const root = mutated.type;
    const context = createDocumentContext(program, service, {
      root,
      service: getService(program, root),
      ...(mutated.realm === null ? {} : { realm: mutated.realm }),
    });
    const first = await buildDocumentFromContext(context, {});
    const second = await buildDocumentFromContext(context, {});

    expect(context.program).toBe(program);
    expect(context.root).not.toBe(service.type);
    expect(context.realm).toBe(mutated.realm);
    expect(context.originalServiceId).toBe("App");
    expect(context.artifactInput.models.map((model) => model.name)).toEqual(["LiveEvent"]);
    expect(context.artifactInput.models[0]).not.toBe(originalModel);
    expect(Object.keys(first.components?.messages ?? {})).toEqual(["LiveEvent"]);
    expect(first).toEqual(second);
    expect(originalModel?.name).toBe("Event");
    expect(service.type.models.has("Removed")).toBe(true);
    expect(listMessages(program).has(context.artifactInput.models[0])).toBe(true);
    for (const reference of referencesIn(first)) expect(resolveRef(first, reference)).toBeDefined();
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("keeps keys, headers, and binding placements independent of build order", async () => {
    const { program } = await AsyncAPITester.compile(`
      @service namespace First {
        @message("Event") @binding("kafka", #{})
        model FirstEvent { @header first: string; id: string; }
        @channel("events") interface Events {
          @send op publish(event: FirstEvent): void;
        }
      }
      @service namespace Second {
        @message("Event") @binding("kafka", #{})
        model SecondEvent { @header second: string; id: string; }
        @channel("events") interface Events {
          @send op publish(event: SecondEvent): void;
        }
      }
    `);
    const first = contextFor(program, namespaceOf(program, "First"));
    const second = contextFor(program, namespaceOf(program, "Second"));
    const firstDoc = await buildDocumentFromContext(first, {});
    const secondDoc = await buildDocumentFromContext(second, {});
    expect(await buildDocumentFromContext(second, {})).toEqual(secondDoc);
    expect(await buildDocumentFromContext(first, {})).toEqual(firstDoc);
    expect(JSON.stringify(firstDoc)).toContain('"first"');
    expect(JSON.stringify(firstDoc)).not.toContain('"second"');
    expect(JSON.stringify(secondDoc)).toContain('"second"');
    expect(JSON.stringify(secondDoc)).not.toContain('"first"');
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("owns a fresh diagnostic ledger for every build, including reuse of one context", async () => {
    const { program } = await AsyncAPITester.compile(`
      @service namespace App {
        @message model Event { id: string; }
        @channel("events") interface Events {
          @send op publish(event: [Event]): void;
        }
      }
    `);
    const context = contextFor(program, namespaceOf(program, "App"));
    await buildDocumentFromContext(context, {});
    expect(diagnosticsWith(program.diagnostics, "unsupported-operation-message-type")).toHaveLength(
      1,
    );
    await buildDocumentFromContext(context, {});
    expect(diagnosticsWith(program.diagnostics, "unsupported-operation-message-type")).toHaveLength(
      2,
    );
  });
});
