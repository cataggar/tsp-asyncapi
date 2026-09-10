import { describe, expect, it } from "vitest";
import { getMinValue, isTemplateInstance, listServices } from "@typespec/compiler";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { planVersionedDocuments, type VersionedDocumentPlan } from "#emitter/versioning.js";
import { discoverOriginalDocumentDeclarations } from "#emitter/service-context.js";
import { emitVersioned, VersioningTester } from "../utils/versioning.js";
import { resolveRef } from "../utils/json-pointer.js";
import { referencesIn } from "../utils/references.js";

const HISTORICAL_PROPERTY = "@typeChangedFrom(V.v2, string) @minValue(1) value: int32;";

function nestedServices(
  parent = "id: string;",
  child = `@message model Event { ${HISTORICAL_PROPERTY} }`,
  versions = "v1, v2",
): string {
  return `
    @service @versioned(V) namespace Outer {
      enum V { ${versions} }
      @message model Parent { ${parent} }
      @service namespace Child { ${child} }
    }
  `;
}

function expectRenamedEndpointInstances(snapshot: VersionedDocumentPlan): void {
  const declarations = snapshot.effective?.declarations;
  if (declarations === undefined) throw new Error("Missing declarations.");
  const interfaces = declarations.channels.filter(
    (type) => type.kind === "Interface" && isTemplateInstance(type),
  );
  const actions = declarations.operations.filter(
    (operation) => operation.interface === undefined && isTemplateInstance(operation),
  );
  const count = snapshot.version === "v3" ? 0 : 2;
  const channelName = snapshot.version === "v1" ? "OldPipe" : "Pipe";
  const actionName = snapshot.version === "v1" ? "oldSend" : "send";
  expect(interfaces).toHaveLength(count);
  expect(actions).toHaveLength(count);
  for (const channel of interfaces) {
    expect(channel.name).toBe(channelName);
    expect(channel.namespace).toBe(snapshot.effective?.root);
  }
  for (const action of actions) {
    expect(action.name).toBe(actionName);
    expect(action.namespace).toBe(snapshot.effective?.root);
  }
  if (snapshot.version !== "v3") {
    expect(actions.map((action) => action.parameters.properties.get("event")?.type)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "Model", name: "Text" }),
        expect.objectContaining({ kind: "Model", name: "Count" }),
      ]),
    );
  }
}

describe("Integration: versioning review regressions", () => {
  it.each([false, true])(
    "retains every renamed message instance and later removes them (reverse=%s)",
    async (reverse) => {
      const aliases = ["alias Text = Envelope<string>;", "alias Count = Envelope<int32>;"];
      if (reverse) aliases.reverse();
      const { documents, diagnostics, program } = await emitVersioned(`
        @service @versioned(V) namespace App {
          enum V { v1, v2, v3 }
          @message @renamedFrom(V.v2, "OldEnvelope") @removed(V.v3)
          model Envelope<T> {
            value: T;
            @removed(V.v2) legacy: string;
            @added(V.v2) replacement: string;
          }
          ${aliases.join("\n")}
        }
      `);
      expectDiagnosticEmpty(diagnostics);
      for (const version of ["v1", "v2"] as const) {
        const doc = documents[`asyncapi.${version}.yaml`];
        const prefix = version === "v1" ? "OldEnvelope" : "Envelope";
        expect(
          Object.keys(doc.components?.messages ?? {}).sort((left, right) =>
            left.localeCompare(right),
          ),
        ).toEqual([`${prefix}Int32`, `${prefix}String`]);
        for (const [argument, type] of [
          ["String", "string"],
          ["Int32", "integer"],
        ]) {
          expect(doc.components?.schemas?.[`${prefix}${argument}`]).toMatchObject({
            properties: { value: { type } },
            required: ["value", version === "v1" ? "legacy" : "replacement"],
          });
        }
        for (const ref of referencesIn(doc)) expect(resolveRef(doc, ref)).toBeDefined();
      }
      expect(Object.keys(documents["asyncapi.v3.yaml"].components?.messages ?? {})).toEqual([]);
      const original = listServices(program)[0].type;
      expect([...original.models.keys()]).toEqual(["Envelope"]);
      const instances = discoverOriginalDocumentDeclarations(program).models.filter(
        (model) => model.namespace === original && isTemplateInstance(model),
      );
      expect(instances).toHaveLength(2);
      for (const instance of instances) {
        expect(instance.name).toBe("Envelope");
        expect([...instance.properties.keys()]).toEqual(["value", "legacy", "replacement"]);
      }
    },
  );

  it.each([false, true])(
    "retains renamed interface and action instances in the live boundary (reverse=%s)",
    async (reverse) => {
      const instances = [
        "alias TextPipe = Pipe<Text>; alias TextSend = send<Text>;",
        "alias CountPipe = Pipe<Count>; alias CountSend = send<Count>;",
      ];
      if (reverse) instances.reverse();
      const { program } = await VersioningTester.compile(`
        @service @versioned(V) @channel("events") namespace App {
          enum V { v1, v2, v3 }
          @message model Text { text: string; }
          @message model Count { count: int32; }
          @dynamicChannel @renamedFrom(V.v2, "OldPipe") @removed(V.v3)
          interface Pipe<T> { @send op publish(event: T): void; }
          @send @renamedFrom(V.v2, "oldSend") @removed(V.v3)
          op send<T>(event: T): void;
          ${instances.join("\n")}
        }
      `);
      const root = listServices(program)[0].type;
      const snapshots = planVersionedDocuments(program, listServices(program));
      expect(snapshots).toHaveLength(3);
      if (snapshots === undefined) throw new Error("Missing snapshots.");
      for (const snapshot of snapshots) expectRenamedEndpointInstances(snapshot);
      expect([...root.interfaces.keys()]).toEqual(["Pipe"]);
      expect([...root.operations.keys()]).toEqual(["send"]);
      expectDiagnosticEmpty(program.diagnostics);
    },
  );

  it.each(["v1", "v2"])(
    "does not import excluded child decorator errors into the selected parent (%s)",
    async (version) => {
      const { documents, diagnostics } = await emitVersioned(nestedServices(), {
        service: "Outer",
        version,
        "file-type": "json",
      });
      expectDiagnosticEmpty(diagnostics);
      expect(Object.keys(documents)).toEqual([`asyncapi.Outer.${version}.json`]);
      expect(
        Object.keys(documents[`asyncapi.Outer.${version}.json`].components?.messages ?? {}),
      ).toEqual(["Parent"]);
    },
  );

  it("keeps historical errors fatal when the child itself is selected", async () => {
    const invalid = await emitVersioned(nestedServices(), {
      service: "Outer.Child",
      version: "v1",
    });
    expect(invalid.outputs).toEqual({});
    expect(invalid.diagnostics.map(({ code }) => code)).toContain("decorator-wrong-target");
    const valid = await emitVersioned(nestedServices(), {
      service: "Outer.Child",
      version: "v2",
    });
    expectDiagnosticEmpty(valid.diagnostics);
    expect(
      valid.documents["asyncapi.Outer.Child.v2.yaml"].components?.schemas?.Event,
    ).toMatchObject({ properties: { value: { type: "integer", minimum: 1 } } });
  });

  it.each(["property", "headers", "historical-type"] as const)(
    "validates actual child-domain dependencies reached through %s",
    async (reference) => {
      const source = nestedServices(
        {
          property: "domain: Child.Domain;",
          "historical-type": "@typeChangedFrom(V.v2, Child.Domain) domain: string;",
          headers: "id: string;",
        }[reference],
        `model Domain { ${HISTORICAL_PROPERTY} }
         @message model Event { ${HISTORICAL_PROPERTY} }`,
      ).replace(
        "@message model Parent",
        reference === "headers"
          ? "@message @headers(Child.Domain) model Parent"
          : "@message model Parent",
      );
      const invalid = await emitVersioned(source, { service: "Outer", version: "v1" });
      expect(invalid.outputs).toEqual({});
      expect(invalid.diagnostics.map(({ code }) => code)).toEqual(["decorator-wrong-target"]);
      const valid = await emitVersioned(source, { service: "Outer", version: "v2" });
      expectDiagnosticEmpty(valid.diagnostics);
      expect(Object.keys(valid.documents)).toEqual(["asyncapi.Outer.v2.yaml"]);
      for (const ref of referencesIn(valid.documents["asyncapi.Outer.v2.yaml"])) {
        expect(resolveRef(valid.documents["asyncapi.Outer.v2.yaml"], ref)).toBeDefined();
      }
    },
  );

  it("does not retain validation dependencies removed from the selected view", async () => {
    const source = nestedServices(
      "@removed(V.v2) domain: Child.Domain; id: string;",
      "model Domain { @typeChangedFrom(V.v3, string) @minValue(1) value: int32; }",
      "v1, v2, v3",
    );
    const removed = await emitVersioned(source, { service: "Outer", version: "v2" });
    expectDiagnosticEmpty(removed.diagnostics);
    expect(removed.documents["asyncapi.Outer.v2.yaml"].components?.schemas?.Parent).toMatchObject({
      required: ["id"],
    });
    const referenced = await emitVersioned(source, { service: "Outer", version: "v1" });
    expect(referenced.outputs).toEqual({});
    expect(referenced.diagnostics.map(({ code }) => code)).toContain("decorator-wrong-target");
  });

  it("distinguishes reachable template instances that share the excluded instance's source node", async () => {
    const source = nestedServices(
      "domain: Child.Value<int32>;",
      `model Value<T> { @typeChangedFrom(V.v2, T) @minValue(1) value: int32; }
       @message model Event { domain: Value<string>; }`,
    );
    const selected = await emitVersioned(source, { service: "Outer", version: "v1" });
    expectDiagnosticEmpty(selected.diagnostics);
    expect(Object.keys(selected.documents)).toEqual(["asyncapi.Outer.v1.yaml"]);
    const excluded = await emitVersioned(source, { service: "Outer.Child", version: "v1" });
    expect(excluded.outputs).toEqual({});
    expect(excluded.diagnostics.map(({ code }) => code)).toContain("decorator-wrong-target");
  });

  it("validates child-domain discriminator variants reached by a selected message", async () => {
    const source = nestedServices(
      "domain: Child.Domain;",
      `@discriminator("kind") model Domain { kind: string; }
       model Variant extends Domain { kind: "variant"; ${HISTORICAL_PROPERTY} }`,
    );
    const invalid = await emitVersioned(source, { service: "Outer", version: "v1" });
    expect(invalid.outputs).toEqual({});
    expect(invalid.diagnostics.map(({ code }) => code)).toContain("decorator-wrong-target");
    const valid = await emitVersioned(source, { service: "Outer", version: "v2" });
    expectDiagnosticEmpty(valid.diagnostics);
    expect(Object.keys(valid.documents)).toEqual(["asyncapi.Outer.v2.yaml"]);
  });

  it("preserves original compile errors even when they belong to an excluded service", async () => {
    const [{ program }, diagnostics] = await VersioningTester.compileAndDiagnose(
      nestedServices("id: string;", "@message model Event { @minValue(1) value: string; }"),
    );
    expect(diagnostics.map(({ code }) => code)).toContain("decorator-wrong-target");
    const prior = [...program.diagnostics];
    const outer = listServices(program).find((service) => service.type.name === "Outer");
    if (outer === undefined) throw new Error("Missing outer service.");
    planVersionedDocuments(program, [outer], "v1");
    expect(program.diagnostics).toEqual(prior);
  });

  it("preserves source metadata, reporting hooks, and prior diagnostics across selection order", async () => {
    const { program } = await VersioningTester.compile(nestedServices());
    const services = listServices(program);
    const parent = services.find((service) => service.type.name === "Outer");
    const child = services.find((service) => service.type.name === "Child");
    if (parent === undefined || child === undefined) throw new Error("Missing service fixture.");
    const property = child.type.models.get("Event")?.properties.get("value");
    if (property === undefined) throw new Error("Missing child property.");
    const originalType = property.type;
    const report = Object.getOwnPropertyDescriptor(program, "reportDiagnostic");
    const reportMany = Object.getOwnPropertyDescriptor(program, "reportDiagnostics");
    const finish = Object.getOwnPropertyDescriptor(program.checker, "finishType");
    planVersionedDocuments(program, [parent], "v1");
    expectDiagnosticEmpty(program.diagnostics);
    planVersionedDocuments(program, [child], "v1");
    const prior = [...program.diagnostics];
    expect(prior.map(({ code }) => code)).toContain("decorator-wrong-target");
    planVersionedDocuments(program, [parent], "v1");
    planVersionedDocuments(program, [parent], "v2");
    expect(program.diagnostics).toEqual(prior);
    expect(Object.getOwnPropertyDescriptor(program, "reportDiagnostic")).toEqual(report);
    expect(Object.getOwnPropertyDescriptor(program, "reportDiagnostics")).toEqual(reportMany);
    expect(Object.getOwnPropertyDescriptor(program.checker, "finishType")).toEqual(finish);
    expect(property.type).toBe(originalType);
    expect(getMinValue(program, property)).toBe(1);
    expect(listServices(program)).toEqual(services);
  });
});
