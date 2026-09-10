import { describe, expect, it } from "vitest";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { emitDocumentsWithDiagnostics } from "../utils/test-host.js";
import { referencesIn } from "../utils/references.js";
import { resolveRef } from "../utils/json-pointer.js";
import { byCodePoint } from "../utils/sort.js";

function application(name: string, marker: string) {
  return `
    @service(#{ title: "${name}" })
    @tag("${marker}")
    @extension("x-app", "${marker}")
    @securityScheme("auth", #{ type: "userPassword", description: "${marker}" })
    @useSecurity("auth")
    @server("broker", #{ host: "${marker}.example", protocol: "kafka" })
    @kafkaServer(#{ schemaRegistryUrl: "https://${marker}.example" })
    namespace ${name} {
      @message("Event")
      @asyncTag("${marker}-message")
      @extension("x-message", "${marker}")
      @kafkaMessage(#{ key: #{ type: "string" } })
      model Event { ${marker}: string; }
      @message model Unused { ${marker}: string; }
      @message model Response { ${marker}: string; }
      @dynamicChannel("reply") interface Replies {}
      @channel("events")
      @extension("x-channel", "${marker}")
      @kafkaChannel(#{ topic: "${marker}" })
      interface Events {
        @send @replyChannel(Replies)
        @useSecurity("auth")
        @kafkaOperation(#{ clientId: #{ type: "string" } })
        @extension("x-action", "${marker}")
        op publish(event: Event): Response;
      }
    }
  `;
}

describe("Integration: isolated service documents", () => {
  it.each(["yaml", "json"])(
    "isolates keys, replies, metadata, bindings, security, and refs in %s",
    async (fileType) => {
      const { documents, diagnostics } = await emitDocumentsWithDiagnostics(
        application("A", "alpha") + application("B", "beta"),
        { "file-type": fileType },
      );
      expectDiagnosticEmpty(diagnostics);
      expect(Object.keys(documents).sort(byCodePoint)).toEqual([
        `asyncapi.A.${fileType}`,
        `asyncapi.B.${fileType}`,
      ]);
      for (const [name, marker, other] of [
        ["A", "alpha", "beta"],
        ["B", "beta", "alpha"],
      ]) {
        const doc = documents[`asyncapi.${name}.${fileType}`];
        expect(Object.keys(doc.components?.messages ?? {}).sort(byCodePoint)).toEqual([
          "Event",
          "Response",
          "Unused",
        ]);
        expect(Object.keys(doc.operations ?? {})).toEqual(["publish"]);
        expect(doc.operations?.publish.bindings).toEqual({
          kafka: { clientId: { type: "string" }, bindingVersion: "0.5.0" },
        });
        expect(Object.keys(doc.channels?.reply.messages ?? {})).toEqual(["Response"]);
        expect(doc.components?.securitySchemes?.auth).toEqual({
          type: "userPassword",
          description: marker,
        });
        expect(doc.servers?.broker.security).toEqual([
          { $ref: "#/components/securitySchemes/auth" },
        ]);
        expect(JSON.stringify(doc)).toContain(marker);
        expect(JSON.stringify(doc)).not.toContain(other);
        for (const ref of referencesIn(doc)) expect(resolveRef(doc, ref)).toBeDefined();
        await expect(doc).toBeValidAsyncAPI();
      }
    },
  );

  it("includes empty HTTP-shaped services without importing their operation message signatures", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(`
      namespace Shared {
        model Data { value: string; }
        @message model Event { value: Data; }
        @message model Unused { ignored: string; }
      }
      @service namespace Http {
        interface Resources { get(): Shared.Event; }
      }
      @service namespace Messaging {
        @channel("events") interface Events { @send op publish(event: Shared.Event): void; }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toHaveLength(2);
    expect(documents["asyncapi.Http.yaml"].components?.messages).toBeUndefined();
    expect(documents["asyncapi.Http.yaml"].channels).toEqual({});
    const messaging = documents["asyncapi.Messaging.yaml"];
    expect(Object.keys(messaging.components?.messages ?? {})).toEqual(["Event"]);
    expect(messaging.components?.schemas).toHaveProperty(["Shared.Data", "properties", "value"]);
    expect(JSON.stringify(messaging)).not.toContain("Unused");
    for (const doc of Object.values(documents)) await expect(doc).toBeValidAsyncAPI();
  });

  it("uses nearest service ownership across nested and reopened namespaces", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(`
      @service namespace Parent {
        namespace Sub { @message model Event { parent: string; } }
        @service namespace Child {
          @message model Event { child: string; }
          @channel("events") interface Events { @receive op consume(): Event; }
        }
      }
      namespace Parent.Sub {
        @channel("events") interface Events { @receive op consume(): Event; }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents).sort(byCodePoint)).toEqual([
      "asyncapi.Parent.Child.yaml",
      "asyncapi.Parent.yaml",
    ]);
    expect(JSON.stringify(documents["asyncapi.Parent.yaml"])).toContain('"parent"');
    expect(JSON.stringify(documents["asyncapi.Parent.yaml"])).not.toContain('"child"');
    expect(JSON.stringify(documents["asyncapi.Parent.Child.yaml"])).not.toContain('"parent"');
  });

  it("permits plain domain models from another service without importing its application metadata", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(
      `
      @service @tag("foreign-tag") @extension("x-foreign", true) namespace Domain {
        model Data { value: string; }
        @message model Foreign { data: string; }
      }
      @service namespace Consumer {
        @message model Local { data: Domain.Data; }
      }
    `,
      { service: "Consumer" },
    );
    expectDiagnosticEmpty(diagnostics);
    const doc = documents["asyncapi.Consumer.yaml"];
    expect(Object.keys(doc.components?.messages ?? {})).toEqual(["Local"]);
    expect(doc.components?.schemas?.Data).toHaveProperty("properties.value");
    expect(JSON.stringify(doc)).not.toContain("foreign");
    expect(doc.components?.messages?.Foreign).toBeUndefined();
  });

  it.each([
    [
      "inherited interface",
      "interface Base { @send op publish(event: Event): void; }",
      "interface Events extends Shared.Base {}",
      "Events_publish",
    ],
    [
      "template interface",
      "interface Base<T> { @send op publish(event: T): void; }",
      "interface Events extends Shared.Base<Shared.Event> {}",
      "Events_publish",
    ],
    [
      "op-is signature",
      "@send op signature(event: Event): void;",
      "interface Events { op publish is Shared.signature; }",
      "publish",
    ],
  ])(
    "does not treat an unowned %s carrier as an ambiguous application",
    async (_, source, realization, operationKey) => {
      const { documents, diagnostics } = await emitDocumentsWithDiagnostics(`
      namespace Shared { @message model Event { id: string; } ${source} }
      @service namespace A { @channel("events") ${realization} }
      @service namespace B {}
    `);
      expectDiagnosticEmpty(diagnostics);
      expect(Object.keys(documents["asyncapi.A.yaml"].operations ?? {})).toEqual([operationKey]);
      expect(Object.keys(documents["asyncapi.A.yaml"].components?.messages ?? {})).toEqual([
        "Event",
      ]);
      expect(documents["asyncapi.B.yaml"].components?.messages).toBeUndefined();
    },
  );

  it.each([
    '@channel("outside") interface Outside {}',
    "@dynamicChannel interface Outside {}",
    "@send op outside(): void;",
    '@channel("outside") interface Outside<T> { @send op publish(value: T): void; } alias Instance = Outside<string>;',
  ])(
    "refuses ambiguous unowned applications even with a service selector: %s",
    async (declaration) => {
      const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(
        `@service namespace A {} @service namespace B {} ${declaration}`,
        { service: "A" },
      );
      expect(outputs).toEqual({});
      expect(diagnostics.map(({ code }) => code)).toContain(
        "tsp-asyncapi/unowned-application-declaration",
      );
    },
  );

  it.each([
    "@send op publish(event: B.Foreign): void;",
    "@receive op publish(): B.Foreign;",
    "@send @replyChannel(B.Replies) op publish(event: Local): Local;",
  ])("rejects cross-service application contracts before writing: %s", async (operation) => {
    const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(
      `
      @service namespace A {
        @message model Local { id: string; }
        @channel("events") interface Events { ${operation} }
      }
      @service namespace B {
        @message model Foreign { id: string; }
        @dynamicChannel interface Replies {}
      }
    `,
      { service: "A" },
    );
    expect(outputs).toEqual({});
    expect(diagnostics.map(({ code }) => code)).toContain("tsp-asyncapi/cross-service-reference");
  });

  it.each([
    "@message model Local { nested: B.Foreign; }",
    "@message @headers(B.Foreign) model Local { id: string; }",
  ])("rejects foreign envelopes reached through payload or headers", async (model) => {
    const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(`
      @service namespace A { ${model} }
      @service namespace B { @message model Foreign { id: string; } }
    `);
    expect(outputs).toEqual({});
    expect(diagnostics.map(({ code }) => code)).toContain("tsp-asyncapi/cross-service-reference");
  });

  it("retains legacy unowned declarations with zero or one original service", async () => {
    const declarations =
      '@message model Event { id: string; } @channel("events") interface Events { @send op publish(event: Event): void; }';
    for (const service of ["", "@service namespace App {}"]) {
      const { documents, diagnostics } = await emitDocumentsWithDiagnostics(
        `${service} ${declarations}`,
      );
      expectDiagnosticEmpty(diagnostics);
      expect(Object.keys(documents)).toEqual(["asyncapi.yaml"]);
      expect(Object.keys(documents["asyncapi.yaml"].components?.messages ?? {})).toEqual(["Event"]);
    }
  });

  it("selects only an exact FQN and preserves the original multi-service filename", async () => {
    const code = application("Group.A", "alpha") + application("Group.B", "beta");
    const all = await emitDocumentsWithDiagnostics(code);
    const selected = await emitDocumentsWithDiagnostics(code, { service: "Group.B" });
    expectDiagnosticEmpty(selected.diagnostics);
    expect(selected.documents).toEqual({
      "asyncapi.Group.B.yaml": all.documents["asyncapi.Group.B.yaml"],
    });
    for (const service of ["B", "beta", " Group.B ", "group.B", "Missing"]) {
      const rejected = await emitDocumentsWithDiagnostics(code, { service });
      expect(rejected.outputs).toEqual({});
      expect(rejected.diagnostics.map(({ code }) => code)).toContain(
        "tsp-asyncapi/unknown-service",
      );
    }
  });

  it("diagnoses only selected document metadata, without importing excluded warnings", async () => {
    const code = `
      @service namespace A {}
      @service namespace B {
        @extension("x-orphan", true) model Plain { id: string; }
        @channel("empty") interface Empty {}
      }
    `;
    const selected = await emitDocumentsWithDiagnostics(code, { service: "A" });
    expectDiagnosticEmpty(selected.diagnostics);
    const all = await emitDocumentsWithDiagnostics(code);
    expect(
      all.diagnostics.filter(({ code }) => code === "tsp-asyncapi/channel-no-messages"),
    ).toHaveLength(1);
  });

  it.each(["fixed.yaml", "{version}.yaml"])(
    "refuses colliding output overrides %s as a complete set",
    async (outputFile) => {
      const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(
        "@service namespace A {} @service namespace B {}",
        { "output-file": outputFile },
      );
      expect(outputs).toEqual({});
      expect(diagnostics.map(({ code }) => code)).toContain("tsp-asyncapi/duplicate-output-file");
    },
  );

  it("allows a literal filename when exactly one selected output remains", async () => {
    const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(
      "@service namespace A {} @service namespace B {}",
      { service: "B", "output-file": "selected.json", "file-type": "json" },
    );
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(outputs)).toEqual(["selected.json"]);
  });

  it("escapes actual service namespace names without replacing their identity", async () => {
    const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(
      "@service namespace `A/B` {} @service namespace Other {}",
    );
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(outputs)).toEqual(["asyncapi.A%2FB.yaml", "asyncapi.Other.yaml"]);
  });

  it("retains owned template channel instances erased by aliases", async () => {
    const { documents, diagnostics } = await emitDocumentsWithDiagnostics(`
      @service namespace A {
        @message model Event { alpha: string; }
        @channel("events") interface Channel<T> { @send op publish(event: T): void; }
        alias Endpoint = Channel<Event>;
      }
      @service namespace B {
        @message model Event { beta: string; }
        @channel("events") interface Channel<T> { @send op publish(event: T): void; }
        alias Endpoint = Channel<Event>;
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    for (const doc of Object.values(documents)) {
      expect(Object.keys(doc.channels ?? {})).toEqual(["events"]);
      expect(Object.keys(doc.channels?.events.messages ?? {})).toEqual(["Event"]);
      expect(Object.keys(doc.operations ?? {})).toHaveLength(1);
    }
    expect(JSON.stringify(documents["asyncapi.A.yaml"])).not.toContain("beta");
    expect(JSON.stringify(documents["asyncapi.B.yaml"])).not.toContain("alpha");
  });

  it("refuses an exact selector that cannot distinguish dotted namespace identities", async () => {
    const { outputs, diagnostics } = await emitDocumentsWithDiagnostics(
      "@service namespace A.B {} @service namespace `A.B` {}",
      { service: "A.B" },
    );
    expect(outputs).toEqual({});
    expect(diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/ambiguous-service-selection",
    );
  });
});
