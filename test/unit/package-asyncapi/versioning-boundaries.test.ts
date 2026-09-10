import { describe, expect, it, vi } from "vitest";
import { basename } from "node:path";
import type { EmitContext } from "@typespec/compiler";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { $onEmit } from "#emitter/emitter.js";
import type { AsyncAPIEmitterOptions } from "#emitter/emitter-options.js";
import type { AsyncAPIDocument } from "#emitter/types/index.js";
import { VersioningTester } from "../../utils/versioning.js";
import { referencesIn } from "../../utils/references.js";
import { resolveRef } from "../../utils/json-pointer.js";

async function emitDirect(source: string, options: AsyncAPIEmitterOptions = {}, noEmit = false) {
  const { program } = await VersioningTester.compile(source, {
    compilerOptions: { noEmit },
  });
  const write = vi.spyOn(program.host, "writeFile").mockResolvedValue(undefined);
  await $onEmit({
    program,
    emitterOutputDir: "/direct-output",
    options: { "file-type": "json", ...options },
  } as EmitContext<AsyncAPIEmitterOptions>);
  const documents = Object.fromEntries(
    write.mock.calls.map(([path, content]) => [
      basename(path),
      JSON.parse(content) as AsyncAPIDocument,
    ]),
  );
  return { program, documents, diagnostics: program.diagnostics };
}

describe("Unit: direct versioned emitter boundaries", () => {
  it.each([false, true])("preserves the no-service fallback (noEmit=%s)", async (noEmit) => {
    const { documents, diagnostics } = await emitDirect(
      "@message model Event { value: string; }",
      {},
      noEmit,
    );
    expectDiagnosticEmpty(diagnostics);
    if (noEmit) {
      expect(documents).toEqual({});
    } else {
      expect(Object.keys(documents)).toEqual(["asyncapi.json"]);
      expect(documents["asyncapi.json"].components?.schemas?.Event).toMatchObject({
        required: ["value"],
      });
    }
  });

  it.each([
    {
      source: "@message model Event {}",
      options: { service: "Missing" },
      code: "unknown-service",
      detail: "(none)",
    },
    {
      source: "@service namespace App {}",
      options: { service: "Missing" },
      code: "unknown-service",
      detail: "App",
    },
    {
      source: "@service namespace App {}",
      options: { version: "v1" },
      code: "invalid-version-selection",
      detail: "no declared root versions",
    },
    {
      source: `
        @service @versioned(V) namespace A { enum V { v1 } }
        @service @versioned(V) namespace B { enum V { v1 } }
      `,
      options: { version: "v1" },
      code: "invalid-version-selection",
      detail: "ambiguous",
    },
  ])("refuses $code without any output ($detail)", async ({ source, options, code, detail }) => {
    const result = await emitDirect(source, options);
    expect(result.documents).toEqual({});
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe(`tsp-asyncapi/${code}`);
    expect(result.diagnostics[0].message).toContain(detail);
  });

  it.each([false, true])(
    "refuses invalid native schemas in root and dependency-only views (transient=%s)",
    async (transient) => {
      const source = `
        @versioned(V) namespace Dependency { enum V { d1 } }
        @service ${transient ? "@useDependency(Dependency.V.d1)" : "@versioned(V)"}
        namespace App {
          enum V { v1 }
          interface Callback {}
          @message model Event { value: Callback; }
        }
      `;
      const result = await emitDirect(source);
      expect(result.documents).toEqual({});
      expect(result.diagnostics.map(({ code }) => code)).toEqual([
        "tsp-asyncapi/unsupported-payload-type",
        "tsp-asyncapi/unsupported-versioned-contract",
      ]);
      expect(result.diagnostics[1].message).toContain(transient ? "dependency-only" : "v1");
    },
  );

  it.each([false, true])(
    "does not claim raw bodies follow field evolution (transient=%s)",
    async (transient) => {
      const source = `
        @versioned(V) namespace Dependency {
          enum V { d1, d2 }
          model Data { @added(V.d2) trace: string; }
        }
        @service ${transient ? "@useDependency(Dependency.V.d1)" : "@versioned(V)"}
        namespace App {
          ${
            transient
              ? ""
              : `enum V {
            @useDependency(Dependency.V.d1) v1,
            @useDependency(Dependency.V.d2) v2
          }`
          }
          @message @rawPayload("application/vnd.apache.avro;version=1.9.0", "string")
          model Event { data: Dependency.Data; }
        }
      `;
      const result = await emitDirect(source);
      expect(result.documents).toEqual({});
      expect(
        result.diagnostics.every(
          ({ code }) => code === "tsp-asyncapi/unsupported-versioned-contract",
        ),
      ).toBe(true);
      expect(result.diagnostics).toHaveLength(transient ? 1 : 2);
      expect(result.diagnostics[0].message).toContain("raw schemas are not transformed");
    },
  );

  it("emits unchanged raw bodies without inventing typed fields", async () => {
    const { documents, diagnostics } = await emitDirect(`
      @service @versioned(V) namespace App {
        enum V { v1, v2 }
        @message @rawPayload("application/vnd.apache.avro;version=1.9.0", "string")
        model Event { typed: string; }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    expect(Object.keys(documents)).toEqual(["asyncapi.v1.json", "asyncapi.v2.json"]);
    for (const doc of Object.values(documents)) {
      expect(doc.components?.messages?.Event.payload).toMatchObject({ schema: "string" });
      expect(doc.components?.schemas ?? {}).not.toHaveProperty("Event");
    }
  });

  it.each([
    { model: "model Headers { trace: string; }", target: "Headers" },
    { model: "model Headers<T> { trace: T; }", target: "Headers<string>" },
    { model: "", target: "{ trace: string; }" },
  ])("uses live named, template, and anonymous headers ($target)", async ({ model, target }) => {
    const { documents, diagnostics } = await emitDirect(`
      @service @versioned(V) namespace App {
        enum V { v1, v2 }
        ${model}
        @message @headers(${target}) model Event { id: string; }
      }
    `);
    expectDiagnosticEmpty(diagnostics);
    for (const doc of Object.values(documents)) {
      const header = doc.components?.messages?.Event.headers;
      expect(header).toBeDefined();
      const schema =
        header !== undefined && "$ref" in header && typeof header.$ref === "string"
          ? resolveRef(doc, header.$ref)
          : header;
      expect(schema).toMatchObject({ properties: { trace: { type: "string" } } });
    }
  });

  it("refuses removed dependency headers even without a root version label", async () => {
    const { documents, diagnostics } = await emitDirect(`
      @versioned(V) namespace Dependency {
        enum V { d1, d2 }
        @removed(V.d2) model Headers { trace: string; }
      }
      @service @useDependency(Dependency.V.d2) namespace App {
        @message @headers(Dependency.Headers) model Event { id: string; }
      }
    `);
    expect(documents).toEqual({});
    expect(diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/unsupported-versioned-contract",
    );
    expect(diagnostics.some(({ message }) => message.includes("not a live model"))).toBe(true);
  });

  it("refuses otherwise-unused versioned alias libraries without a resolved choice", async () => {
    const result = await emitDirect(`
      @versioned(V) namespace Dependency {
        enum V { d1, d2 }
        @message model Envelope<T> { value: T; @added(V.d2) trace: string; }
        alias Only = Envelope<string>;
      }
      @service @versioned(V) namespace App { enum V { v1 } }
    `);
    expect(result.documents).toEqual({});
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "tsp-asyncapi/unsupported-versioned-contract",
    ]);
  });

  it("keeps inherited operation carriers and live headers scoped away from excluded child errors", async () => {
    const { documents, diagnostics } = await emitDirect(
      `
      namespace Shared {
        interface Base<T> { @send op publish(event: T): void; }
      }
      @service @versioned(V) namespace Outer {
        enum V { v1, v2 }
        @message @headers(Child.Headers) model Event { id: string; }
        @channel("events") interface Events extends Shared.Base<Event> {}
        @service namespace Child {
          model Headers { trace: string; }
          @message model Unused {
            @typeChangedFrom(V.v2, string) @minValue(1) value: int32;
          }
        }
      }
    `,
      { service: "Outer", version: "v1" },
    );
    expectDiagnosticEmpty(diagnostics);
    const doc = documents["asyncapi.Outer.v1.json"];
    expect(Object.keys(doc.operations ?? {})).toEqual(["Events_publish"]);
    expect(Object.keys(doc.components?.messages ?? {})).toEqual(["Event"]);
    for (const ref of referencesIn(doc)) expect(resolveRef(doc, ref)).toBeDefined();
  });

  it("refuses transitive discriminator replay errors but emits the valid grandchild view", async () => {
    const source = `
      @service @versioned(V) namespace Outer {
        enum V { v1, v2 }
        @message model Parent { domain: Child.Domain; }
        @service namespace Child {
          @discriminator("kind") model Domain { kind: string; }
          model Middle extends Domain {}
          model Variant extends Middle {
            kind: "variant";
            @typeChangedFrom(V.v2, string) @minValue(1) value: int32;
            parent?: Domain;
          }
        }
      }
    `;
    const invalid = await emitDirect(source, { service: "Outer", version: "v1" });
    expect(invalid.documents).toEqual({});
    expect(invalid.diagnostics.map(({ code }) => code)).toEqual(["decorator-wrong-target"]);
    const valid = await emitDirect(source, { service: "Outer", version: "v2" });
    expectDiagnosticEmpty(valid.diagnostics);
    expect(valid.documents["asyncapi.Outer.v2.json"].components?.schemas?.Variant).toMatchObject({
      allOf: [
        { $ref: "#/components/schemas/Middle" },
        { properties: { value: { type: "integer", minimum: 1 } } },
      ],
    });
  });
});
