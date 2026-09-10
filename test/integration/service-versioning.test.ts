import { describe, expect, it } from "vitest";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { listServices, isTemplateInstance } from "@typespec/compiler";
import { emitVersioned, VersioningTester } from "../utils/versioning.js";
import { emitDocumentsWithDiagnostics } from "../utils/test-host.js";
import { referencesIn } from "../utils/references.js";
import { resolveRef } from "../utils/json-pointer.js";
import { planVersionedDocuments } from "#emitter/versioning.js";
import {
  createServiceDocumentContext,
  discoverOriginalDocumentDeclarations,
} from "#emitter/service-context.js";
import { buildDocumentFromContext } from "#emitter/pipeline.js";
import type { AsyncAPIDocument, SchemaObject } from "#emitter/types/index.js";

const MIXED = `
  namespace Shared { model Value { id: string; } }
  @service(#{ title: "Versioned" }) @versioned(Versions)
  @server("broker", #{ host: "versioned.example", protocol: "kafka" })
  @securityScheme("auth", #{ type: "userPassword" }) @useSecurity("auth")
  namespace Apps.Versioned {
    enum Versions { first: "v1", second: "v2" }
    model Headers {
      @removed(Versions.second) oldHeader: string;
      @added(Versions.second) newHeader: string;
    }
    @message("Event") @headers(Headers) model Event {
      @removed(Versions.second) legacy: string;
      @added(Versions.second) replacement: string;
      shared: Shared.Value;
    }
    @message model Result { ok: boolean; }
    @channel("commands") interface Commands {
      @send @replyChannel(Replies) op request(event: Event): Result;
    }
    @channel("replies") interface Replies {}
  }
  @service(#{ title: "Static" }) @info(#{ version: "release" })
  @server("broker", #{ host: "static.example", protocol: "kafka" })
  @securityScheme("auth", #{ type: "userPassword" }) @useSecurity("auth")
  namespace Apps.Static {
    @message("Event") model Event { plain: string; shared: Shared.Value; }
    @channel("events") interface Events { @send op publish(event: Event): void; }
  }
`;

const BINARY_REFUSAL = `
  @service @versioned(Versions) @Avro.avroNamespace("binary")
  namespace Binary {
    enum Versions { v1, v2 }
    @message @Avro.avroRecord model Event {
      id: string;
      @added(Versions.v2) unsupported: unknown;
      @added(Versions.v2) @visibility(Lifecycle.Read)
      @jsonSchemaExtension("type", "invalid") value: string;
    }
  }
`;

const INVALID_NATIVE_EXTENSION = `
  @service namespace Native {
    @message model Event {
      @jsonSchemaExtension("type", "invalid") value: string;
    }
  }
`;

function assertReferences(documents: Readonly<Record<string, AsyncAPIDocument>>) {
  for (const doc of Object.values(documents)) {
    for (const ref of referencesIn(doc)) expect(resolveRef(doc, ref), ref).toBeDefined();
  }
}

describe("Integration: actual service/version output sets", () => {
  it("isolates versioned, unversioned, and actual HTTP-only services", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(
      `${MIXED}
       @service(#{ title: "HTTP" }) namespace Apps.Web {
         @TypeSpec.Http.route("/status") @TypeSpec.Http.get op status(): string;
       }`,
      {},
      false,
      VersioningTester.import("@typespec/http"),
    );
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toEqual([
      "asyncapi.Apps.Versioned.v1.yaml",
      "asyncapi.Apps.Versioned.v2.yaml",
      "asyncapi.Apps.Static.yaml",
      "asyncapi.Apps.Web.yaml",
    ]);
    const first = documents["asyncapi.Apps.Versioned.v1.yaml"];
    const second = documents["asyncapi.Apps.Versioned.v2.yaml"];
    const plain = documents["asyncapi.Apps.Static.yaml"];
    expect(first.components?.schemas?.["Apps.Event"]).toMatchObject({
      required: ["legacy", "shared"],
    });
    expect(second.components?.schemas?.["Apps.Event"]).toMatchObject({
      required: ["replacement", "shared"],
    });
    expect(first.components?.schemas?.["Apps.Headers"]).toMatchObject({ required: ["oldHeader"] });
    expect(second.components?.schemas?.["Apps.Headers"]).toMatchObject({ required: ["newHeader"] });
    expect(plain.info.version).toBe("release");
    expect(plain.components?.schemas?.["Apps.Event"]).toMatchObject({
      required: ["plain", "shared"],
    });
    expect(Object.keys(plain.components?.messages ?? {})).toEqual(["Event"]);
    expect(first.servers?.broker).toMatchObject({ host: "versioned.example" });
    expect(plain.servers?.broker).toMatchObject({ host: "static.example" });
    for (const doc of [first, second, plain]) {
      expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["auth"]);
    }
    expect(first.operations?.request.reply).toBeDefined();
    expect(plain.operations).not.toHaveProperty("request");
    expect(documents["asyncapi.Apps.Web.yaml"].channels).toEqual({});
    expect(documents["asyncapi.Apps.Web.yaml"].operations).toEqual({});
    assertReferences(documents);
    for (const doc of Object.values(documents)) await expect(doc).toBeValidAsyncAPI();
  });

  it("selects service then exact version while retaining original naming identities", async () => {
    const { documents, diagnostics } = await emitVersioned(MIXED, {
      service: "Apps.Versioned",
      version: "v2",
      "file-type": "json",
    });
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toEqual(["asyncapi.Apps.Versioned.v2.json"]);
    expect(documents["asyncapi.Apps.Versioned.v2.json"].info.version).toBe("v2");
    assertReferences(documents);
  });

  it("selects all versions of one service without importing another service", async () => {
    const { documents, diagnostics } = await emitVersioned(MIXED, { service: "Apps.Versioned" });
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toEqual([
      "asyncapi.Apps.Versioned.v1.yaml",
      "asyncapi.Apps.Versioned.v2.yaml",
    ]);
    expect(JSON.stringify(documents)).not.toContain("static.example");
  });

  it.each([
    { version: "v1" },
    { service: "Apps.Static", version: "v1" },
    { service: "Apps.Versioned", version: "first" },
  ])("refuses invalid version/service selection %j", async (options) => {
    const { outputs, diagnostics } = await emitVersioned(MIXED, options);
    expect(outputs).toEqual({});
    expect(diagnostics.map(({ code }) => code)).toContain("tsp-asyncapi/invalid-version-selection");
  });

  it("preflights the complete mixed output set using the shared filename helper", async () => {
    const collision = await emitVersioned(MIXED, { "output-file": "contract.yaml" });
    expect(collision.outputs).toEqual({});
    expect(collision.diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/duplicate-output-file",
    );
    const selected = await emitVersioned(MIXED, {
      service: "Apps.Versioned",
      version: "v1",
      "output-file": "contract.yaml",
    });
    expectDiagnosticEmpty(selected.diagnostics);
    expect(Object.keys(selected.outputs)).toEqual(["contract.yaml"]);
  });

  it("withholds valid other-service outputs when one version has a raw/header mismatch", async () => {
    const { outputs, diagnostics } = await emitVersioned(
      MIXED.replace(
        /model Headers \{[^}]*\}/,
        "@removed(Versions.second) model Headers { trace: string; }",
      ),
    );
    expect(outputs).toEqual({});
    expect(diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/unsupported-versioned-contract",
    );
  });

  it.each(["yaml", "json"] as const)(
    "withholds all versioned outputs for a malformed later unversioned extension (%s)",
    async (fileType) => {
      const { outputs, diagnostics } = await emitVersioned(
        `
          @service @versioned(Versions) namespace Versioned {
            enum Versions { v1, v2 }
            @message model Event { value: string; }
          }
          ${INVALID_NATIVE_EXTENSION}
        `,
        { "file-type": fileType },
      );
      expect(outputs).toEqual({});
      expect(diagnostics.map(({ code }) => code)).toEqual([
        "tsp-asyncapi/invalid-schema-extension",
      ]);
    },
  );

  it.each([false, true])(
    "continues other contexts without lowering a refused version as native (binary first=%s)",
    async (binaryFirst) => {
      const sources = [BINARY_REFUSAL, INVALID_NATIVE_EXTENSION];
      if (!binaryFirst) sources.reverse();
      const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(
        sources.join("\n"),
        { "preview-features": ["avro"] },
        false,
        VersioningTester.import("tsp-avro"),
      );
      expect(outputs).toEqual({});
      expect(
        diagnostics.map(({ code }) => code).sort((left, right) => left.localeCompare(right)),
      ).toEqual([
        "tsp-asyncapi/avro-artifact-unavailable",
        "tsp-asyncapi/invalid-schema-extension",
      ]);
    },
  );

  it("does not collect or lower refused and malformed unselected service/version views", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(
      `${BINARY_REFUSAL}\n${INVALID_NATIVE_EXTENSION}`,
      { service: "Binary", version: "v1", "preview-features": ["avro"] },
      false,
      VersioningTester.import("tsp-avro"),
    );
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toEqual(["asyncapi.Binary.v1.yaml"]);
    expect(documents["asyncapi.Binary.v1.yaml"].components?.messages?.Event.payload).toHaveProperty(
      "schemaFormat",
    );
  });

  it("independently collects Avro and Protobuf versions beside an unchanged native service", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(
      `
      @service @versioned(Versions) @Avro.avroNamespace("example.avro")
      namespace AvroApp {
        enum Versions { v1, v2 }
        @message @Avro.avroRecord model Event {
          @removed(Versions.v2) legacy: string;
          @added(Versions.v2) replacement: string;
        }
      }
      @service @versioned(Versions) @TypeSpec.Protobuf.package({ name: "example.proto" })
      namespace ProtoApp {
        enum Versions { v1, v2 }
        @message @TypeSpec.Protobuf.message model Event {
          @TypeSpec.Protobuf.field(1) @removed(Versions.v2) legacy: string;
          @TypeSpec.Protobuf.field(2) @added(Versions.v2) replacement: string;
        }
      }
      @service namespace Native { @message model Event { plain: string; } }
    `,
      { "preview-features": ["avro", "protobuf"] },
      false,
      VersioningTester.import("tsp-avro", "@typespec/protobuf"),
    );
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toHaveLength(5);
    for (const [name, doc] of Object.entries(documents)) {
      if (name.includes("Native")) {
        expect(doc.components?.schemas?.Event).toMatchObject({ required: ["plain"] });
      } else {
        const payload = doc.components?.messages?.Event.payload;
        expect(payload).toHaveProperty("schemaFormat");
        expect(JSON.stringify(payload)).toContain(
          doc.info.version === "v1" ? "legacy" : "replacement",
        );
        expect(JSON.stringify(payload)).not.toContain(
          doc.info.version === "v1" ? "replacement" : "legacy",
        );
      }
    }
    assertReferences(documents);
  });

  it("combines root versions and dependency-only services with independent dependency choices", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @versioned(Versions) namespace Library {
        enum Versions { d1, d2 }
        model Data {
          @removed(Versions.d2) legacy: string;
          @added(Versions.d2) replacement: string;
        }
      }
      @service @versioned(Versions) namespace Versioned {
        enum Versions {
          @useDependency(Library.Versions.d1) v1,
          @useDependency(Library.Versions.d2) v2
        }
        @message model Event { data: Library.Data; }
      }
      @service @info(#{ version: "independent" }) @useDependency(Library.Versions.d1)
      namespace Transient { @message model Event { data: Library.Data; } }
    `);
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toEqual([
      "asyncapi.Versioned.v1.yaml",
      "asyncapi.Versioned.v2.yaml",
      "asyncapi.Transient.yaml",
    ]);
    expect(
      documents["asyncapi.Versioned.v1.yaml"].components?.schemas?.["Library.Data"],
    ).toMatchObject({ required: ["legacy"] });
    expect(
      documents["asyncapi.Versioned.v2.yaml"].components?.schemas?.["Library.Data"],
    ).toMatchObject({ required: ["replacement"] });
    expect(
      documents["asyncapi.Transient.yaml"].components?.schemas?.["Library.Data"],
    ).toMatchObject({ required: ["legacy"] });
    expect(documents["asyncapi.Transient.yaml"].info.version).toBe("independent");
    assertReferences(documents);
  });

  it("applies ownership after removal rather than rejecting the selected view's former references", async () => {
    const source = `
      @service @versioned(Versions) namespace A {
        enum Versions { v1, v2 }
        @message model Local {
          @removed(Versions.v2) foreign: B.Foreign;
          local: string;
        }
      }
      @service namespace B { @message model Foreign { value: string; } }
    `;
    const invalid = await emitVersioned(source);
    expect(invalid.outputs).toEqual({});
    expect(invalid.diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/cross-service-reference",
    );
    const selected = await emitVersioned(source, { service: "A", version: "v2" });
    expectDiagnosticEmpty(selected.diagnostics);
    expect(Object.keys(selected.documents)).toEqual(["asyncapi.A.v2.yaml"]);
    expect(selected.documents["asyncapi.A.v2.yaml"].components?.schemas?.Local).toMatchObject({
      required: ["local"],
    });
    expect(selected.documents["asyncapi.A.v2.yaml"].components?.messages).not.toHaveProperty(
      "Foreign",
    );
  });
});

const ALIASES = `
  @service @versioned(Versions) namespace App {
    enum Versions { v1, v2 }
    @message @renamedFrom(Versions.v2, "OldEnvelope") model Envelope<T> {
      value: T;
      @madeOptional(Versions.v2) relaxed?: string;
      @removed(Versions.v2) legacy: string;
      @added(Versions.v2) replacement: string;
    }
    @message @removed(Versions.v2) model Retired<T> { value: T; }
    @message @added(Versions.v2) model Introduced<T> { value: T; }
    alias Unused = Envelope<string>;
    alias Old = Retired<string>;
    alias New = Introduced<string>;
    @dynamicChannel @renamedFrom(Versions.v2, "OldChannel") interface Channel<T> {
      @send @renamedFrom(Versions.v2, "oldPublish") op publish(event: T): void;
    }
    alias Active = Channel<Envelope<string>>;
    @channel("retired") @removed(Versions.v2) interface RetiredChannel<T> {
      @send op retire(event: T): void;
    }
    alias OldEndpoint = RetiredChannel<Retired<string>>;
    @channel("introduced") @added(Versions.v2) interface IntroducedChannel<T> {
      @send op introduce(event: T): void;
    }
    alias NewEndpoint = IntroducedChannel<Introduced<string>>;
  }
  @service namespace Unrelated { @message model Other { foreign: string; } }
`;

describe("Integration: genuine version mutation of erased aliases", () => {
  it("retains, removes, renames, and changes actual aliased messages and interfaces", async () => {
    const { documents, diagnostics, program } = await emitVersioned(ALIASES, { service: "App" });
    expectDiagnosticEmpty(diagnostics);
    const old = documents["asyncapi.App.v1.yaml"];
    const current = documents["asyncapi.App.v2.yaml"];
    expect(Object.keys(old.components?.messages ?? {})).toEqual([
      "OldEnvelopeString",
      "RetiredString",
    ]);
    expect(Object.keys(current.components?.messages ?? {})).toEqual([
      "EnvelopeString",
      "IntroducedString",
    ]);
    expect(Object.keys(old.channels ?? {})).toEqual(["OldChannel", "retired"]);
    expect(Object.keys(current.channels ?? {})).toEqual(["Channel", "introduced"]);
    expect(Object.keys(old.operations ?? {})).toEqual(["oldPublish", "retire"]);
    expect(Object.keys(current.operations ?? {})).toEqual(["publish", "introduce"]);
    expect(old.components?.schemas?.OldEnvelopeString).toMatchObject({
      required: ["value", "relaxed", "legacy"],
    });
    expect(current.components?.schemas?.EnvelopeString).toMatchObject({
      required: ["value", "replacement"],
    });
    assertReferences(documents);
    const source = listServices(program).find((service) => service.type.name === "App");
    expect(source?.type.models.has("Envelope")).toBe(true);
    expect(source?.type.models.has("OldEnvelope")).toBe(false);
    expect(
      [...(source?.type.models.keys() ?? [])].some((name) => name.startsWith("__asyncapi")),
    ).toBe(false);
  });

  it("versions standalone alias actions without recovering removed snapshots or provenance operations", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) @channel("events") namespace App {
        enum Versions { v1, v2 }
        @message model Event { id: string; }
        @send @renamedFrom(Versions.v2, "oldSend") op sendEvent<T>(event: T): void;
        @send @removed(Versions.v2) op retired<T>(event: T): void;
        @send @added(Versions.v2) op introduced<T>(event: T): void;
        alias Active = sendEvent<Event>;
        alias Old = retired<Event>;
        alias New = introduced<Event>;
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents["asyncapi.v1.yaml"].operations ?? {})).toEqual([
      "oldSend",
      "retired",
    ]);
    expect(Object.keys(documents["asyncapi.v2.yaml"].operations ?? {})).toEqual([
      "sendEvent",
      "introduced",
    ]);
    assertReferences(documents);
  });

  it("does not promote sourceOperation provenance into an extra versioned action", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      namespace Shared { @send op carrier<T>(event: T): void; }
      @service @versioned(Versions) namespace App {
        enum Versions { v1, v2 }
        @message model Event { id: string; }
        @channel("events") interface Events { op publish is Shared.carrier<Event>; }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    for (const doc of Object.values(documents))
      expect(Object.keys(doc.operations ?? {})).toEqual(["publish"]);
  });

  it("owns only live alias identities and rebuilds snapshots in either order on the original Program", async () => {
    const { program } = await VersioningTester.compile(ALIASES);
    const services = listServices(program);
    const originalInventory = discoverOriginalDocumentDeclarations(program);
    const originals = originalInventory.models.filter(isTemplateInstance);
    const snapshots = planVersionedDocuments(program, [services[0]]);
    if (snapshots === undefined) throw new Error("Expected version snapshots.");
    const contexts = snapshots.map((snapshot) => {
      const context = createServiceDocumentContext(
        program,
        snapshot.originalService,
        services,
        snapshot.effective,
      );
      if (context === undefined) throw new Error("Expected complete alias boundary.");
      return context;
    });
    for (const context of contexts) {
      for (const model of context.artifactInput.models) {
        expect(originals).not.toContain(model);
        expect(model.namespace).toBe(context.root);
      }
    }
    const forward = await Promise.all(
      contexts.map((context) => buildDocumentFromContext(context, {})),
    );
    const reverse = await Promise.all(
      [...contexts].reverse().map((context) => buildDocumentFromContext(context, {})),
    );
    reverse.reverse();
    expect(forward).toEqual(reverse);
    const envelope = originals.find((model) => model.name === "Envelope");
    expect([...(envelope?.properties.keys() ?? [])]).toEqual([
      "value",
      "relaxed",
      "legacy",
      "replacement",
    ]);
    const selected = planVersionedDocuments(program, [services[0]], "v2");
    if (selected === undefined) throw new Error("Expected selected snapshot.");
    const current = createServiceDocumentContext(
      program,
      services[0],
      services,
      selected[0].effective,
    );
    if (current === undefined) throw new Error("Expected current snapshot.");
    const doc = await buildDocumentFromContext(current, {});
    expect(doc.components?.messages).not.toHaveProperty("RetiredString");
    expect((doc.components?.schemas?.EnvelopeString as SchemaObject).required).toEqual([
      "value",
      "replacement",
    ]);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("mutates otherwise-unused dependency aliases in the legacy single-service transient view", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @versioned(Versions) namespace Library {
        enum Versions { d1, d2 }
        @message model Envelope<T> {
          value: T;
          @removed(Versions.d2) legacy: string;
          @added(Versions.d2) replacement: string;
        }
        alias Message = Envelope<string>;
      }
      @service @useDependency(Library.Versions.d1) namespace App {}
    `);
    expectDiagnosticEmpty(diagnostics);
    expect(
      documents["asyncapi.yaml"].components?.schemas?.["Library.EnvelopeString"],
    ).toMatchObject({ required: ["value", "legacy"] });
    expect(JSON.stringify(documents)).not.toContain('"replacement"');
  });

  it("refuses unselected versioned alias libraries instead of importing their original hybrid bodies", async () => {
    const { outputs, diagnostics } = await emitVersioned(`
      @versioned(Versions) namespace Library {
        enum Versions { d1, d2 }
        @message model Envelope<T> {
          value: T;
          @removed(Versions.d2) legacy: string;
          @added(Versions.d2) replacement: string;
        }
        alias Message = Envelope<string>;
      }
      @service @versioned(Versions) namespace App { enum Versions { v1, v2 } }
    `);
    expect(outputs).toEqual({});
    expect(diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/unsupported-versioned-contract",
    );
  });

  it("mutates aliased receive return types before channel message discovery", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) @channel("events") namespace App {
        enum Versions { v1, v2 }
        @message model Old { legacy: string; }
        @message model Current { replacement: string; }
        @receive @returnTypeChangedFrom(Versions.v2, Old) op read<T>(): T;
        alias Read = read<Current>;
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    expect(documents["asyncapi.v1.yaml"].operations?.read.messages).toEqual([
      { $ref: "#/channels/events/messages/Old" },
    ]);
    expect(documents["asyncapi.v2.yaml"].operations?.read.messages).toEqual([
      { $ref: "#/channels/events/messages/Current" },
    ]);
    assertReferences(documents);
  });

  it("isolates nested services that inherit their enclosing root version choices", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) namespace Outer {
        enum Versions { v1, v2 }
        @message model Parent { parent: string; }
        @service namespace Inner {
          @message model Child {
            @removed(Versions.v2) legacy: string;
            @added(Versions.v2) replacement: string;
          }
        }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toEqual([
      "asyncapi.Outer.v1.yaml",
      "asyncapi.Outer.v2.yaml",
      "asyncapi.Outer.Inner.v1.yaml",
      "asyncapi.Outer.Inner.v2.yaml",
    ]);
    for (const [name, doc] of Object.entries(documents)) {
      if (name.includes("Inner")) {
        expect(Object.keys(doc.components?.messages ?? {})).toEqual(["Child"]);
        expect(doc.components?.schemas?.Child).toMatchObject({
          required: [doc.info.version === "v1" ? "legacy" : "replacement"],
        });
      } else {
        expect(Object.keys(doc.components?.messages ?? {})).toEqual(["Parent"]);
      }
    }
    assertReferences(documents);
  });

  it.each(["avro", "protobuf"] as const)(
    "explicitly refuses unsupported %s template-instance payloads across the whole output set",
    async (provider) => {
      const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(
        `
        @service @versioned(Versions)
        ${provider === "avro" ? '@Avro.avroNamespace("example")' : '@TypeSpec.Protobuf.package({ name: "example" })'}
        namespace App {
          enum Versions { v1, v2 }
          @message ${provider === "avro" ? "@Avro.avroRecord" : "@TypeSpec.Protobuf.message"}
          model Event<T> {
            ${provider === "protobuf" ? "@TypeSpec.Protobuf.field(1)" : ""}
            @removed(Versions.v2) legacy: T;
            ${provider === "protobuf" ? "@TypeSpec.Protobuf.field(2)" : ""}
            @added(Versions.v2) replacement: T;
          }
          alias Payload = Event<string>;
        }
        @service namespace Native { @message model Event { id: string; } }
      `,
        { "preview-features": [provider] },
        false,
        VersioningTester.import(provider === "avro" ? "tsp-avro" : "@typespec/protobuf"),
      );
      expect(outputs).toEqual({});
      expect(diagnostics.map(({ code }) => code)).toEqual([
        `tsp-asyncapi/${provider}-artifact-unavailable`,
        `tsp-asyncapi/${provider}-artifact-unavailable`,
      ]);
    },
  );

  it("mutates erased message aliases with anonymous template arguments", async () => {
    const { documents, diagnostics } = await emitVersioned(`
      @service @versioned(Versions) namespace App {
        enum Versions { v1, v2 }
        @message("AliasMessage") model Envelope<T> {
          value: T;
          @removed(Versions.v2) legacy: string;
          @added(Versions.v2) replacement: string;
        }
        alias AnonymousArgument = Envelope<{ id: string; }>;
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    for (const doc of Object.values(documents)) {
      const payload = doc.components?.messages?.AliasMessage.payload;
      const schema =
        payload !== undefined && "$ref" in payload && typeof payload.$ref === "string"
          ? resolveRef(doc, payload.$ref)
          : payload;
      expect(schema).toMatchObject({
        required: ["value", doc.info.version === "v1" ? "legacy" : "replacement"],
        properties: { value: { type: "object", required: ["id"] } },
      });
    }
  });
});
