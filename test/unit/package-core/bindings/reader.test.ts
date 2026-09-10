import { describe, expect, it } from "vitest";
import { listServices } from "@typespec/compiler";
import { expectDiagnosticEmpty, t } from "@typespec/compiler/testing";
import { getBindings, getServers, type BindingState } from "tsp-asyncapi-core";
import { AsyncAPITester } from "#core/testing.js";
import { buildAsyncAPIDocument } from "#emitter/pipeline.js";
import { diagnosticsWith } from "../../../utils/diagnostics.js";
import { resolveRef } from "../../../utils/json-pointer.js";

describe("Unit: public binding inspection", () => {
  it("returns an empty list for an undecorated target", async () => {
    const { Target, program } = await AsyncAPITester.compile(t.code`
      model ${t.model("Target")} {}
    `);
    expect(getBindings(program, Target)).toEqual([]);
  });

  it("exposes all declarations in source order without targets or renderers", async () => {
    const { Target, program } = await AsyncAPITester.compile(t.code`
      @binding("amqp1", #{})
      @binding("amqp1", #{ bindingVersion: "0.1.0" })
      @binding("amqp", #{ nested: #{ flags: #[false] } })
      @kafkaChannel(#{ partitions: 2 })
      interface ${t.interface("Target")} {}
    `);
    expect(getBindings(program, Target)).toEqual([
      { protocol: "amqp1", scope: "any", config: {} },
      { protocol: "amqp1", scope: "any", config: { bindingVersion: "0.1.0" } },
      { protocol: "amqp", scope: "any", config: { nested: { flags: [false] } } },
      { protocol: "kafka", scope: "channel", config: { partitions: 2 } },
    ]);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("retains the distinct declared placements of protocol-specific decorators", async () => {
    const { Service, Event, publish, program } = await AsyncAPITester.compile(t.code`
      @kafkaServer(#{ schemaRegistryVendor: "registry" })
      @kafkaChannel(#{ partitions: 2 })
      @binding("amqp1", #{})
      namespace ${t.namespace("Service")} {
        @kafkaMessage(#{ schemaIdLocation: "payload" })
        model ${t.model("Event")} { id: string; }

        @kafkaOperation(#{ groupId: #{ type: "string" } })
        op ${t.op("publish")}(event: Event): void;
      }
    `);
    expect(getBindings(program, Service)).toEqual([
      { protocol: "kafka", scope: "server", config: { schemaRegistryVendor: "registry" } },
      { protocol: "kafka", scope: "channel", config: { partitions: 2 } },
      { protocol: "amqp1", scope: "any", config: {} },
    ]);
    expect(getBindings(program, Event)).toEqual([
      { protocol: "kafka", scope: "message", config: { schemaIdLocation: "payload" } },
    ]);
    expect(getBindings(program, publish)).toEqual([
      { protocol: "kafka", scope: "operation", config: { groupId: { type: "string" } } },
    ]);
  });

  it("copies the returned array, entries and nested binding config", async () => {
    const { Target, program } = await AsyncAPITester.compile(t.code`
      @binding("custom", #{ nested: #{ flags: #[false], detail: #{ count: 1 } } })
      interface ${t.interface("Target")} {}
    `);
    const bindings = getBindings(program, Target);
    const config = bindings[0].config as {
      nested: { flags: boolean[]; detail: { count: number } };
    };
    config.nested.flags.push(true);
    config.nested.detail.count = 9;
    const writable = bindings[0] as {
      protocol: string;
      scope: string;
      config: Record<string, unknown>;
    };
    writable.protocol = "changed";
    writable.scope = "server";
    writable.config = {};
    (bindings as BindingState[]).splice(0);

    expect(getBindings(program, Target)).toEqual([
      {
        protocol: "custom",
        scope: "any",
        config: { nested: { flags: [false], detail: { count: 1 } } },
      },
    ]);
  });

  it("exposes shared server bindings and preserves each emitted server's config", async () => {
    const { Service, program } = await AsyncAPITester.compile(t.code`
      @service(#{ title: "Orders" })
      @server("primary", #{ host: "primary.example.com", protocol: "amqps" })
      @server("secondary", #{ host: "secondary.example.com", protocol: "amqps" })
      @binding("amqp1", #{ bindingVersion: "0.1.0", nested: #{ flags: #[false] } })
      namespace ${t.namespace("Service")} {}
    `);
    expect(getServers(program, Service).map((server) => server.name)).toEqual([
      "primary",
      "secondary",
    ]);
    const bindings = getBindings(program, Service);
    expect(bindings).toEqual([
      {
        protocol: "amqp1",
        scope: "any",
        config: { bindingVersion: "0.1.0", nested: { flags: [false] } },
      },
    ]);
    (bindings[0].config.nested as { flags: boolean[] }).flags.push(true);
    const document = await buildAsyncAPIDocument(program, listServices(program)[0], {});
    const servers = Object.values(document.servers ?? {});
    expect(servers).toHaveLength(2);
    for (const server of servers) {
      const bindings = server.bindings;
      const resolved =
        bindings && "$ref" in bindings && typeof bindings.$ref === "string"
          ? resolveRef(document, bindings.$ref)
          : bindings;
      expect(resolved).toEqual({
        amqp1: { bindingVersion: "0.1.0", nested: { flags: [false] } },
      });
    }
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("keeps duplicate and wrong-placement diagnostics with the emitter", async () => {
    const { Target, Unused, program } = await AsyncAPITester.compile(t.code`
      @service(#{ title: "Orders" })
      namespace Test;

      @channel("orders")
      @binding("amqp1", #{})
      @binding("amqp1", #{ bindingVersion: "0.1.0" })
      interface ${t.interface("Target")} {}

      @binding("custom", #{})
      model ${t.model("Unused")} {}
    `);
    expect(getBindings(program, Target)).toHaveLength(2);
    expect(getBindings(program, Unused)).toHaveLength(1);
    expectDiagnosticEmpty(program.diagnostics);
    await buildAsyncAPIDocument(program, listServices(program)[0], {});
    expect(diagnosticsWith(program.diagnostics, "duplicate-binding")).toHaveLength(1);
    expect(diagnosticsWith(program.diagnostics, "binding-outside-document")).toHaveLength(1);
  });
});
