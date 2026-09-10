import { describe, expect, it, vi } from "vitest";
import { getService, listServices } from "@typespec/compiler";
import { unsafe_mutateSubgraphWithNamespace } from "@typespec/compiler/experimental";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { listMessages } from "tsp-asyncapi-core";
import { createDocumentContext } from "#emitter/document-context.js";
import { createProtobufProvider } from "#emitter/schema-artifacts/protobuf.js";
import { createAvroProvider } from "#emitter/schema-artifacts/avro.js";
import {
  collectSchemaArtifacts,
  type SchemaArtifactProvider,
} from "#emitter/schema-artifacts/provider.js";
import { buildDocumentFromContext } from "#emitter/pipeline.js";
import { createLibraryTester } from "../../../utils/emitter-package.js";

describe("Unit: scoped artifact inputs", () => {
  it.each([
    {
      id: "protobuf",
      library: "@typespec/protobuf",
      namespace: '@Protobuf.package({ name: "app" })',
      model: "@Protobuf.message",
      property: "@Protobuf.field(1)",
      provider: createProtobufProvider,
    },
    {
      id: "avro",
      library: "tsp-avro",
      namespace: '@Avro.avroNamespace("app")',
      model: "@Avro.avroRecord",
      property: "",
      provider: createAvroProvider,
    },
  ] as const)("collects $id only for live models of the requested document", async (fixture) => {
    const { program } = await createLibraryTester(fixture.library).compile(`
      @service ${fixture.namespace} namespace App {
        @message ${fixture.model} model Event { ${fixture.property} id: string; }
        @message ${fixture.model} model Removed { ${fixture.property} id: string; }
      }
    `);
    const originalService = listServices(program)[0];
    const originalMessages = listMessages(program);
    const mutated = unsafe_mutateSubgraphWithNamespace(
      program,
      [
        {
          name: `scoped-${fixture.id}`,
          Namespace(source, clone) {
            if (source === originalService.type) clone.models.delete("Removed");
          },
          Model(source, clone) {
            if (source.name === "Event") clone.name = "LiveEvent";
          },
          // Select properties too, so the compiler finishes their decorator state.
          ModelProperty(source, clone) {
            clone.optional = source.optional;
          },
        },
      ],
      originalService.type,
    );
    if (mutated.type.kind !== "Namespace") throw new Error("Expected a live namespace.");
    const context = createDocumentContext(program, originalService, {
      root: mutated.type,
      service: getService(program, mutated.type),
      ...(mutated.realm === null ? {} : { realm: mutated.realm }),
    });
    const provider = fixture.provider();
    const collect = vi.spyOn(provider, "collect");
    const collected = await collectSchemaArtifacts(
      program,
      new Set([fixture.id]),
      [provider],
      context.artifactInput,
    );

    expect(collect).toHaveBeenCalledExactlyOnceWith(program, context.artifactInput);
    expectDiagnosticEmpty(program.diagnostics);
    expect(collected.refused).toBe(false);
    expect([...collected.artifacts.payloadFor.keys()]).toEqual(context.artifactInput.models);
    expect(context.artifactInput.models.map((model) => model.name)).toEqual(["LiveEvent"]);
    expect(originalMessages.has(context.artifactInput.models[0])).toBe(false);
    const doc = await buildDocumentFromContext(context, {}, collected.artifacts);
    expect(Object.keys(doc.components?.messages ?? {})).toEqual(["LiveEvent"]);
    expect(doc.components?.messages?.LiveEvent.payload).toHaveProperty("schemaFormat");
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("collects no artifacts for an explicit empty model scope", async () => {
    const { program } = await createLibraryTester("@typespec/protobuf").compile(`
      @message @Protobuf.message model Outside { @Protobuf.field(1) id: string; }
    `);
    const input = { program, models: [] };
    const collected = await collectSchemaArtifacts(
      program,
      new Set(["protobuf"]),
      [createProtobufProvider()],
      input,
    );
    expect(collected.artifacts.payloadFor.size).toBe(0);
    expect(collected.refused).toBe(false);
  });

  it("rejects an artifact input attached to a different Program", async () => {
    const tester = createLibraryTester("tsp-avro");
    const { program } = await tester.compile("");
    const other = await tester.compile("");
    const collect = vi.fn<SchemaArtifactProvider["collect"]>();
    const provider: SchemaArtifactProvider = {
      id: "avro",
      collect,
    };
    await expect(
      collectSchemaArtifacts(program, new Set(["avro"]), [provider], {
        program: other.program,
        models: [],
      }),
    ).rejects.toThrow("original Program");
    expect(collect).not.toHaveBeenCalled();
  });
});
