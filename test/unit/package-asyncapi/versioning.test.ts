import { describe, expect, it, vi } from "vitest";
import { listServices, type EmitContext } from "@typespec/compiler";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { getHeadersModel, listMessages } from "tsp-asyncapi-core";
import { listRecords } from "tsp-avro";
import { planVersionedDocuments } from "#emitter/versioning.js";
import { createDocumentContext } from "#emitter/document-context.js";
import { buildDocumentFromContext } from "#emitter/pipeline.js";
import { collectSchemaArtifacts } from "#emitter/schema-artifacts/provider.js";
import { retainedMessageVersions, VersioningTester } from "../../utils/versioning.js";
import { $onEmit } from "#emitter/emitter.js";
import type { AsyncAPIEmitterOptions } from "#emitter/emitter-options.js";

describe("Unit: versioning adapter boundaries", () => {
  it("isolates effective identities and produces the same results in either snapshot build order", async () => {
    const { program } = await VersioningTester.compile(retainedMessageVersions);
    const services = listServices(program);
    const originalMessages = [...listMessages(program).keys()];
    const plans = planVersionedDocuments(program, services);
    if (plans === undefined) throw new Error("Expected valid version plans.");
    const contexts = plans.map((plan) =>
      createDocumentContext(program, plan.originalService, plan.effective),
    );
    expect(contexts).toHaveLength(2);
    expect(contexts[0].root).not.toBe(contexts[1].root);
    expect(contexts[0].realm).not.toBe(contexts[1].realm);
    const models = contexts.map((context) => context.artifactInput.models[0]);
    expect(models[0]).not.toBe(models[1]);
    for (const context of contexts) {
      expect(context.program).toBe(program);
      expect(context.originalService).toBe(services[0]);
      expect(context.originalServiceId).toBe("App");
      expect(context.artifactInput.models[0]).not.toBe(originalMessages[0]);
      expect(context.sourceModels?.has(context.artifactInput.models[0])).toBe(true);
      expect([
        ...(context.sourceModels?.get(context.artifactInput.models[0])?.properties.keys() ?? []),
      ]).toEqual(["legacy", "replacement"]);
      const asked: unknown[] = [];
      await collectSchemaArtifacts(
        program,
        new Set(["avro"]),
        [
          {
            id: "avro",
            collect: (original, input) => {
              expect(original).toBe(program);
              asked.push(...(input?.models ?? []));
              return Promise.resolve({ artifacts: { payloadFor: new Map() }, refused: false });
            },
          },
        ],
        context.artifactInput,
      );
      expect(asked).toEqual(context.artifactInput.models);
    }
    const forward = await Promise.all(
      contexts.map((context) => buildDocumentFromContext(context, {})),
    );
    const reverse = await Promise.all(
      [...contexts].reverse().map((context) => buildDocumentFromContext(context, {})),
    );
    reverse.reverse();
    expect(forward).toEqual(reverse);
    expect(listServices(program)).toEqual(services);
    expect([...originalMessages[0].properties.keys()]).toEqual(["legacy", "replacement"]);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("replays decorators with effective model arguments without changing original state", async () => {
    const { program } = await VersioningTester.compile(`
      @service @versioned(Versions) namespace App {
        enum Versions { v1, v2 }
        model Headers { @added(Versions.v2) trace: string; }
        @message @headers(Headers) model Event { id: string; }
      }
    `);
    const services = listServices(program);
    const original = services[0].type.models.get("Event");
    if (original === undefined) throw new Error("Missing Event fixture.");
    const originalHeaders = getHeadersModel(program, original);
    const plans = planVersionedDocuments(program, services);
    if (plans === undefined) throw new Error("Expected valid version plans.");
    for (const plan of plans) {
      const root = plan.effective?.root;
      const event = root?.models.get("Event");
      if (event === undefined) throw new Error("Missing effective Event fixture.");
      expect(getHeadersModel(program, event)).toBe(root?.models.get("Headers"));
      expect(getHeadersModel(program, event)).not.toBe(originalHeaders);
    }
    expect(getHeadersModel(program, original)).toBe(originalHeaders);
    expect(originalHeaders?.properties.has("trace")).toBe(true);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("leaves the unversioned context API and whole-program fallback unchanged", async () => {
    const { program } = await VersioningTester.compile("@service namespace App {}");
    const plans = planVersionedDocuments(program, listServices(program));
    if (plans === undefined) throw new Error("Expected valid version plans.");
    expect(plans).toHaveLength(1);
    expect(plans[0].effective?.root).toBe(listServices(program)[0].type);
    expect(plans[0].effective?.declarations).toBeDefined();
    expect(plans[0].effective?.realm).toBeUndefined();
    expect(plans[0].version).toBeUndefined();
  });

  it("keeps a subsequent standalone Avro emitter on the original source models", async () => {
    const { program } = await VersioningTester.import("tsp-avro").compile(
      retainedMessageVersions.replace("@message model", "@Avro.avroRecord @message model"),
    );
    const originals = listRecords(program);
    expect(originals).toHaveLength(1);
    planVersionedDocuments(program, listServices(program));
    expect(listRecords(program)).toEqual(originals);
    expect([...originals[0].properties.keys()]).toEqual(["legacy", "replacement"]);
  });

  it("validates a direct emitter call with noEmit but never writes files", async () => {
    const { program } = await VersioningTester.compile(retainedMessageVersions, {
      compilerOptions: { noEmit: true },
    });

    const write = vi.spyOn(program.host, "writeFile");
    await $onEmit({
      program,
      emitterOutputDir: "/test/no-output",
      options: {},
    } as EmitContext<AsyncAPIEmitterOptions>);
    expectDiagnosticEmpty(program.diagnostics);
    expect(write).not.toHaveBeenCalled();
    await $onEmit({
      program,
      emitterOutputDir: "/test/no-output",
      options: { version: "unknown" },
    } as EmitContext<AsyncAPIEmitterOptions>);
    expect(program.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "tsp-asyncapi/invalid-version-selection",
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("preserves original alias-only Avro records for a subsequent standalone emitter", async () => {
    const { program } = await VersioningTester.import("tsp-avro").compile(`
      @service @versioned(Versions) @Avro.avroNamespace("example")
      namespace App {
        enum Versions { v1, v2 }
        @message @Avro.avroRecord model Envelope<T> {
          value: T;
          @removed(Versions.v2) legacy: string;
          @added(Versions.v2) replacement: string;
        }
        alias OnlyAlias = Envelope<string>;
      }
    `);
    const originals = listRecords(program);
    expect(originals).toHaveLength(1);
    planVersionedDocuments(program, listServices(program));
    expect(listRecords(program)).toEqual(originals);
    expect([...originals[0].properties.keys()]).toEqual(["value", "legacy", "replacement"]);
  });
});
