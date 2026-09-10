import { describe, expect, it } from "vitest";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { emitVersioned, retainedMessageVersions, VersioningTester } from "../utils/versioning.js";
import { emitDocumentsWithDiagnostics } from "../utils/test-host.js";
import type { SchemaObject } from "#emitter/types/index.js";
import { referencesIn } from "../utils/references.js";
import { resolveRef } from "../utils/json-pointer.js";

describe("Integration: version-aware emission", () => {
  it("emits legacy only in v1 and replacement only in v2, including required sets", async () => {
    const { documents, diagnostics } = await emitVersioned(retainedMessageVersions);
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toEqual(["asyncapi.1.0.yaml", "asyncapi.2.0.yaml"]);
    for (const [version, property] of [
      ["1.0", "legacy"],
      ["2.0", "replacement"],
    ]) {
      const doc = documents[`asyncapi.${version}.yaml`];
      expect(doc.info.version).toBe(version);
      const schema = doc.components?.schemas?.Event as SchemaObject | undefined;
      expect(schema, JSON.stringify(doc)).toMatchObject({
        properties: { [property]: { type: "string" } },
        required: [property],
      });
      expect(Object.keys(schema?.properties ?? {})).toEqual([property]);
    }
  });

  it("versions property/model names, optionality, types and recursive shared references", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) namespace App {
        enum Versions { v1: "v1", v2: "v2" }
        @renamedFrom(Versions.v2, "OldNode")
        model Node {
          @renamedFrom(Versions.v2, "oldName") name: string;
          @madeOptional(Versions.v2) relaxed?: string;
          @madeRequired(Versions.v2) tightened: string;
          @typeChangedFrom(Versions.v2, string) value: int32;
          next?: Node;
        }
        @message model Event { left: Node; right: Node; }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    for (const [filename, doc] of Object.entries(documents)) {
      const old = filename.includes("v1");
      const schema = doc.components?.schemas?.[old ? "OldNode" : "Node"] as SchemaObject;
      expect(schema.properties).toHaveProperty(old ? "oldName" : "name");
      expect(schema.properties).not.toHaveProperty(old ? "name" : "oldName");
      expect(schema.properties?.value).toMatchObject({ type: old ? "string" : "integer" });
      expect(schema.required).toContain(old ? "relaxed" : "tightened");
      expect(schema.required).not.toContain(old ? "tightened" : "relaxed");
      for (const ref of referencesIn(doc)) expect(resolveRef(doc, ref), ref).toBeDefined();
    }
  });

  it("versions interface channels, message declarations, operation names and signatures", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) namespace App {
        enum Versions { v1: "v1", v2: "v2" }
        @message model Request { id: string; }
        @message model OldResult { old: string; }
        @message model NewResult { current: string; }
        @message @removed(Versions.v2) model Retired { id: string; }
        @message @added(Versions.v2) model Introduced { id: string; }
        @removed(Versions.v2) @channel("retired") interface Old {
          @send op retire(event: Retired): void;
        }
        @added(Versions.v2) @channel("introduced") interface New {
          @send op introduce(event: Introduced): void;
        }
        @renamedFrom(Versions.v2, "OldEvents") @dynamicChannel
        interface Events {
          @renamedFrom(Versions.v2, "oldPublish")
          @send op publish(@typeChangedFrom(Versions.v2, OldResult) event: NewResult): void;
          @returnTypeChangedFrom(Versions.v2, OldResult)
          @receive op read(): NewResult;
          @removed(Versions.v2) @send op retireOperation(event: Request): void;
          @added(Versions.v2) @send op introduceOperation(event: Request): void;
        }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    const old = documents["asyncapi.v1.yaml"];
    const current = documents["asyncapi.v2.yaml"];
    expect(Object.keys(old.channels ?? {})).toEqual(["retired", "OldEvents"]);
    expect(Object.keys(current.channels ?? {})).toEqual(["introduced", "Events"]);
    expect(old.components?.messages).toHaveProperty("Retired");
    expect(old.components?.messages).not.toHaveProperty("Introduced");
    expect(current.components?.messages).toHaveProperty("Introduced");
    expect(current.components?.messages).not.toHaveProperty("Retired");
    expect(old.operations).toHaveProperty("oldPublish");
    expect(old.operations).not.toHaveProperty("publish");
    expect(current.operations).toHaveProperty("publish");
    expect(current.operations).not.toHaveProperty("oldPublish");
    expect(old.operations?.oldPublish.messages).toEqual([
      { $ref: "#/channels/OldEvents/messages/OldResult" },
    ]);
    expect(current.operations?.read.messages).toEqual([
      { $ref: "#/channels/Events/messages/NewResult" },
    ]);
    for (const doc of Object.values(documents)) {
      for (const ref of referencesIn(doc)) expect(resolveRef(doc, ref), ref).toBeDefined();
    }
  });

  it("uses effective explicit headers and parameter types before header and channel planning", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) namespace App {
        enum Versions { v1: "v1", v2: "v2" }
        model Headers {
          @removed(Versions.v2) legacy: string;
          @added(Versions.v2) replacement: string;
        }
        @message @headers(Headers) model Event { body: string; }
        @channel("events/{tenant}") interface Events {
          @send op publish(
            event: Event,
            @typeChangedFrom(Versions.v2, "old") tenant: "new"
          ): void;
        }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    const old = documents["asyncapi.v1.yaml"];
    const current = documents["asyncapi.v2.yaml"];
    expect(old.components?.parameters?.tenant).toMatchObject({ enum: ["old"] });
    expect(current.components?.parameters?.tenant).toMatchObject({ enum: ["new"] });
    expect(old.components?.schemas?.Headers).toMatchObject({ required: ["legacy"] });
    expect(current.components?.schemas?.Headers).toMatchObject({ required: ["replacement"] });
  });

  it("versions lifted headers separately from the payload", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) namespace App {
        enum Versions { v1: "v1", v2: "v2" }
        @message model Event {
          @header @removed(Versions.v2) oldHeader: string;
          @header @added(Versions.v2) newHeader: string;
          @removed(Versions.v2) oldBody: string;
          @added(Versions.v2) newBody: string;
        }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    for (const doc of Object.values(documents)) {
      const old = doc.info.version === "v1";
      expect(doc.components?.messages?.Event).toMatchObject({
        headers: {
          properties: { [old ? "oldHeader" : "newHeader"]: { type: "string" } },
          required: [old ? "oldHeader" : "newHeader"],
        },
      });
      expect(doc.components?.schemas?.EventPayload).toMatchObject({
        required: [old ? "oldBody" : "newBody"],
      });
    }
  });

  it("honors declared dependency and transitive choices instead of choosing latest", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @versioned(Versions) namespace Leaf {
        enum Versions { l1, l2, l3 }
        model Data {
          @removed(Versions.l2) legacy: string;
          @added(Versions.l2) replacement: string;
          @added(Versions.l3) future: string;
        }
      }
      @versioned(Versions) namespace Dependency {
        enum Versions {
          @useDependency(Leaf.Versions.l1) d1,
          @useDependency(Leaf.Versions.l2) d2
        }
        model Data { leaf: Leaf.Data; }
      }
      @service @versioned(Versions) namespace App {
        enum Versions {
          @useDependency(Dependency.Versions.d1) v1: "first",
          @useDependency(Dependency.Versions.d2) v2: "second"
        }
        @message model Event { data: Dependency.Data; }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toHaveLength(2);
    for (const doc of Object.values(documents)) {
      expect(doc.components?.schemas?.["Leaf.Data"]).toMatchObject({
        required: [doc.info.version === "first" ? "legacy" : "replacement"],
      });
      expect(JSON.stringify(doc)).not.toContain('"future"');
      for (const ref of referencesIn(doc)) expect(resolveRef(doc, ref), ref).toBeDefined();
    }
  });

  it("supports dependency-only transient mutation while preserving unversioned metadata", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @versioned(Versions) namespace Dependency {
        enum Versions { old, current }
        model Data {
          @removed(Versions.current) legacy: string;
          @added(Versions.current) replacement: string;
        }
      }
      @service @info(#{ version: "release" })
      @useDependency(Dependency.Versions.old) namespace App {
        @message model Event { data: Dependency.Data; }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toEqual(["asyncapi.yaml"]);
    const doc = documents["asyncapi.yaml"];
    expect(doc.info.version).toBe("release");
    expect(doc.components?.schemas?.["Dependency.Data"]).toMatchObject({ required: ["legacy"] });
    expect(JSON.stringify(doc)).not.toContain('"replacement"');
  });

  it("selects an exact enum value without renaming the remaining output", async () => {
    const { documents, diagnostics } = await emitVersioned(retainedMessageVersions, {
      version: "2.0",
      "file-type": "json",
    });
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toEqual(["asyncapi.2.0.json"]);
    expect(documents["asyncapi.2.0.json"].info.version).toBe("2.0");
  });

  it.each(["v2", "latest", ""])("rejects unknown version value %j", async (version) => {
    const { outputs, diagnostics } = await emitVersioned(retainedMessageVersions, { version });
    expect(outputs).toEqual({});
    expect(diagnostics.map((d) => d.code)).toContain("tsp-asyncapi/invalid-version-selection");
  });

  it("rejects selection on an unversioned service", async () => {
    const { outputs, diagnostics } = await emitVersioned("@service namespace App {}", {
      version: "1.0",
    });
    expect(outputs).toEqual({});
    expect(diagnostics.map((d) => d.code)).toContain("tsp-asyncapi/invalid-version-selection");
  });

  it("does not treat authored info.version as a schema selector", async () => {
    const source = retainedMessageVersions.replace(
      "@service",
      '@info(#{ version: "1.0" }) @service',
    );
    const { documents, diagnostics } = await emitVersioned(source);
    expect(Object.keys(documents)).toHaveLength(2);
    expect(documents["asyncapi.2.0.yaml"].info.version).toBe("2.0");
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["tsp-asyncapi/version-info-conflict", "warning"],
    ]);
  });

  it("preflights literal filenames and permits a unique selected output", async () => {
    const { outputs, diagnostics } = await emitVersioned(retainedMessageVersions, {
      "output-file": "contract.yaml",
    });
    expect(outputs).toEqual({});
    expect(diagnostics.map((d) => d.code)).toContain("tsp-asyncapi/duplicate-output-file");
    const selected = await emitVersioned(retainedMessageVersions, {
      "output-file": "contract.yaml",
      version: "1.0",
    });
    expectDiagnosticEmpty(selected.diagnostics);
    expect(Object.keys(selected.outputs)).toEqual(["contract.yaml"]);
  });

  it("supports version/file-type output templates", async () => {
    const { outputs, diagnostics } = await emitVersioned(retainedMessageVersions, {
      "output-file": "specs/{version}/events.{file-type}",
      "file-type": "json",
    });
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(outputs)).toEqual(["specs/1.0/events.json", "specs/2.0/events.json"]);
  });

  it("prevents portable case-folded filename collisions", async () => {
    const { outputs, diagnostics } = await emitVersioned(
      retainedMessageVersions.replace('"1.0"', '"VERSION"').replace('"2.0"', '"version"'),
    );
    expect(outputs).toEqual({});
    expect(diagnostics.map((d) => d.code)).toContain("tsp-asyncapi/duplicate-output-file");
  });

  it("diagnoses per-view literal address mismatches without writing any view", async () => {
    const { outputs, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) namespace App {
        enum Versions { v1, v2 }
        @message model Event { id: string; }
        @channel("events/{tenant}") interface Events {
          @send op publish(event: Event, @renamedFrom(Versions.v2, "account") tenant: string): void;
        }
      }
    `);
    expect(outputs).toEqual({});
    expect(diagnostics.map((d) => d.code)).toContain("tsp-asyncapi/missing-channel-param");
    expect(diagnostics.map((d) => d.code)).toContain("tsp-asyncapi/unsupported-versioned-contract");
  });

  it("rejects unsupported version decorator targets before emission", async () => {
    const { outputs, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) namespace App {
        enum Versions { v1, v2 }
        @added(Versions.v2) @channel("events") namespace Events {}
      }
    `);
    expect(outputs).toEqual({});
    expect(diagnostics.map((d) => d.code)).toContain("decorator-wrong-target");
  });

  it("preserves original source types and service registry for other emitters", async () => {
    const { program, diagnostics } = await emitVersioned(retainedMessageVersions);
    expectDiagnosticEmpty(diagnostics);
    const original = program.getGlobalNamespaceType().namespaces.get("App");
    const event = original?.models.get("Event");
    if (event === undefined) throw new Error("Missing original Event fixture.");
    expect([...event.properties.keys()]).toEqual(["legacy", "replacement"]);
    expect(
      original?.interfaces
        .get("Events")
        ?.operations.get("publish")
        ?.parameters.properties.get("event")?.type,
    ).toBe(event);
  });

  it("honors compiler noEmit without writing version outputs", async () => {
    const [result, diagnostics] = await VersioningTester.emit("tsp-asyncapi").compileAndDiagnose(
      retainedMessageVersions,
      { compilerOptions: { noEmit: true } },
    );
    expectDiagnosticEmpty(diagnostics);
    expect(result.outputs).toEqual({});
  });

  it.each(["avro", "protobuf"] as const)(
    "collects %s artifacts using each snapshot's effective model identities",
    async (provider) => {
      const tester = VersioningTester.import(
        provider === "avro" ? "tsp-avro" : "@typespec/protobuf",
      );
      const source = `
        @service @versioned(Versions)
        ${provider === "protobuf" ? '@TypeSpec.Protobuf.package({ name: "example" })' : '@Avro.avroNamespace("example")'}
        namespace App {
          enum Versions { v1, v2 }
          @message
          ${provider === "avro" ? "@Avro.avroRecord" : "@TypeSpec.Protobuf.message"}
          model Event {
            ${provider === "protobuf" ? "@TypeSpec.Protobuf.field(1)" : ""}
            @removed(Versions.v2) legacy: string;
            ${provider === "protobuf" ? "@TypeSpec.Protobuf.field(2)" : ""}
            @added(Versions.v2) replacement: string;
          }
        }
      `;
      const { documents, diagnostics } = await emitDocumentsWithDiagnostics(
        source,
        { "preview-features": [provider] },
        false,
        tester,
      );
      expectDiagnosticEmpty(diagnostics);
      for (const doc of Object.values(documents)) {
        const payload = doc.components?.messages?.Event.payload;
        expect(payload).toHaveProperty("schemaFormat");
        const schema = JSON.stringify(payload);
        expect(schema).toContain(doc.info.version === "v1" ? "legacy" : "replacement");
        expect(schema).not.toContain(doc.info.version === "v1" ? "replacement" : "legacy");
      }
    },
  );

  it("refuses generated payload/header combinations rather than falling back to native schemas", async () => {
    const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(
      `
        @service @versioned(Versions) namespace App {
          enum Versions { v1, v2 }
          @message @Avro.avroRecord model Event { @header id: string; }
        }
      `,
      { "preview-features": ["avro"] },
      false,
      VersioningTester.import("tsp-avro"),
    );
    expect(outputs).toEqual({});
    expect(diagnostics.map((d) => d.code)).toContain("tsp-asyncapi/header-on-generated-payload");
  });

  it("checks raw schema references independently for every selected view", async () => {
    const { outputs, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) namespace App {
        enum Versions { v1, v2 }
        @renamedFrom(Versions.v2, "OldData") model Data { id: string; }
        @message model Native { data: Data; }
        @message
        @rawPayload("application/vnd.aai.asyncapi;version=3.1.0",
          #{ $ref: "#/components/schemas/Data" })
        model Raw {}
      }
    `);
    expect(outputs).toEqual({});
    expect(diagnostics.map((d) => d.code)).toContain("tsp-asyncapi/unresolved-raw-schema-ref");
  });

  it("retains unchanged raw schemas, decorator strings and addresses verbatim", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) namespace App {
        enum Versions { v1, v2 }
        @message("wireName") @renamedFrom(Versions.v2, "Old")
        @rawPayload("application/vnd.apache.avro;version=1.9.0", "string")
        model Current {}
        @channel("literal.address") @renamedFrom(Versions.v2, "OldEvents")
        interface Events { @send op publish(event: Current): void; }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    for (const doc of Object.values(documents)) {
      expect(Object.keys(doc.channels ?? {})).toEqual(["literal.address"]);
      expect(doc.components?.messages?.wireName).toMatchObject({
        payload: { schema: "string" },
      });
    }
  });

  it("refuses to imply typed property versioning transforms a raw payload", async () => {
    const { outputs, diagnostics } = await emitVersioned(
      retainedMessageVersions.replace(
        "@message model Event",
        '@message @rawPayload("application/vnd.apache.avro;version=1.9.0", "string") model Event',
      ),
    );
    expect(outputs).toEqual({});
    expect(diagnostics.map((d) => d.code)).toContain("tsp-asyncapi/unsupported-versioned-contract");
  });

  it("rejects a header decorator referencing a removed model in a selected view", async () => {
    const { outputs, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) namespace App {
        enum Versions { v1, v2 }
        @removed(Versions.v2) model Headers { trace: string; }
        @message @headers(Headers) model Event { id: string; }
      }
    `);
    expect(outputs).toEqual({});
    expect(diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("rejects ambiguous version selection even when services share the value", async () => {
    const { outputs, diagnostics } = await emitVersioned(
      `
      @service @versioned(Versions) namespace First { enum Versions { v1 } }
      @service @versioned(Versions) namespace Second { enum Versions { v1 } }
    `,
      { version: "v1" },
    );
    expect(outputs).toEqual({});
    expect(diagnostics.map((d) => d.code)).toContain("tsp-asyncapi/invalid-version-selection");
  });

  it("refuses raw body evolution even if all annotated fields were removed from the selected view", async () => {
    const { outputs, diagnostics } = await emitVersioned(
      `
      @service @versioned(Versions) namespace App {
        enum Versions { v1, v2 }
        @message @rawPayload("application/vnd.apache.avro;version=1.9.0", "string")
        model Event { @removed(Versions.v2) legacy: string; }
      }
    `,
      { version: "v2" },
    );
    expect(outputs).toEqual({});
    expect(diagnostics.map((d) => d.code)).toContain("tsp-asyncapi/unsupported-versioned-contract");
  });

  it("supports versioned dependency headers supplied through a template decorator argument", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @versioned(Versions) namespace Dependency {
        enum Versions { d1, d2 }
        model Data { @added(Versions.d2) trace: string; }
      }
      @service @versioned(Versions) namespace App {
        enum Versions {
          @useDependency(Dependency.Versions.d1) v1,
          @useDependency(Dependency.Versions.d2) v2
        }
        model Headers<T> { data: T; }
        @message @headers(Headers<Dependency.Data>) model Event { id: string; }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    for (const doc of Object.values(documents)) {
      const schema = doc.components?.schemas?.["Dependency.Data"] as SchemaObject;
      expect(Object.keys(schema.properties ?? {})).toEqual(
        doc.info.version === "v1" ? [] : ["trace"],
      );
    }
  });

  it("replays service, server and security metadata separately for every version", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @service(#{ title: "App" }) @versioned(Versions)
      @server("broker", #{ host: "broker.example", protocol: "kafka" })
      @securityScheme("auth", #{ type: "userPassword" }) @useSecurity("auth")
      namespace App {
        enum Versions { v1, v2 }
        @message model Event { id: string; }
        @channel("events") interface Events { @send op publish(event: Event): void; }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    for (const doc of Object.values(documents)) {
      expect(doc.info.title).toBe("App");
      expect(Object.keys(doc.servers ?? {})).toEqual(["broker"]);
      expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["auth"]);
      for (const ref of referencesIn(doc)) expect(resolveRef(doc, ref), ref).toBeDefined();
    }
  });

  it("refuses an unselected versioned namespace in the no-service fallback", async () => {
    const { outputs, diagnostics } = await emitVersioned(
      retainedMessageVersions.replace("@service ", ""),
    );
    expect(outputs).toEqual({});
    expect(diagnostics.map((d) => d.code)).toContain("tsp-asyncapi/unsupported-versioned-contract");
  });

  it("rejects a selector shared by two root enum members", async () => {
    const { outputs, diagnostics } = await emitVersioned(
      retainedMessageVersions.replace('"1.0"', '"same"').replace('"2.0"', '"same"'),
      { version: "same" },
    );
    expect(outputs).toEqual({});
    expect(diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
  });
});
