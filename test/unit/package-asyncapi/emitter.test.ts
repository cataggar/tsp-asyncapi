import { describe, it, expect, vi } from "vitest";
import type { EmitContext, Program } from "@typespec/compiler";
import { AsyncAPITester } from "#emitter/testing.js";
import { $onEmit } from "#emitter/emitter.js";
import type { AsyncAPIEmitterOptions } from "#emitter/emitter-options.js";

// Builds the emit context with the three members this emitter reads. The
// compiler builds a larger one; nothing here touches the rest of it.
function emitContextFor(
  program: Program,
  options: AsyncAPIEmitterOptions,
): EmitContext<AsyncAPIEmitterOptions> {
  return {
    program,
    emitterOutputDir: "/mock-out",
    options,
  } as EmitContext<AsyncAPIEmitterOptions>;
}

describe("Unit: $onEmit", () => {
  it("writes the document to the file the options name", async () => {
    const runner = await AsyncAPITester.createInstance();
    await runner.compile(`
      @service(#{ title: "Emit Test" })
      namespace Test;
    `);

    // The write is captured with a spy so the call arguments can be read off
    // it. Nothing restores the spy, because `createInstance` builds a fresh
    // host for each case.
    const writeFile = vi.spyOn(runner.program.host, "writeFile").mockResolvedValue(undefined);

    await $onEmit(
      emitContextFor(runner.program, { "file-type": "json", "output-file": "custom.json" }),
    );

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0];
    expect(path).toContain("custom.json");
    expect(content).toContain('"title": "Emit Test"');
  });

  it.each([false, true])(
    "withholds every output when a later document has ambiguous security (noEmit=%s)",
    async (noEmit) => {
      const runner = await AsyncAPITester.createInstance();
      await runner.compile(
        `
      @securityScheme("auth", #{ type: "plain" }) namespace Shared {}
      @securityScheme("auth", #{ type: "userPassword" }) namespace OtherShared {}
      @service namespace A {}
      @service @useSecurity("auth")
      @server("broker", #{ host: "b.example", protocol: "kafka" }) namespace B {}
    `,
        { compilerOptions: { noEmit } },
      );
      const writeFile = vi.spyOn(runner.program.host, "writeFile").mockResolvedValue(undefined);
      await $onEmit(emitContextFor(runner.program, {}));
      expect(runner.program.diagnostics.map(({ code }) => code)).toContain(
        "tsp-asyncapi/ambiguous-security-scheme",
      );
      expect(writeFile).not.toHaveBeenCalled();
    },
  );

  it("runs ownership diagnostics under noEmit before writing a selected app", async () => {
    const runner = await AsyncAPITester.createInstance();
    await runner.compile(
      "@service namespace A {} @service namespace B {} @send op outside(): void;",
      { compilerOptions: { noEmit: true } },
    );
    const writeFile = vi.spyOn(runner.program.host, "writeFile").mockResolvedValue(undefined);
    await $onEmit(emitContextFor(runner.program, { service: "A" }));
    expect(runner.program.diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/unowned-application-declaration",
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("runs output collision diagnostics under noEmit", async () => {
    const runner = await AsyncAPITester.createInstance();
    await runner.compile("@service namespace A {} @service namespace B {}", {
      compilerOptions: { noEmit: true },
    });
    const writeFile = vi.spyOn(runner.program.host, "writeFile").mockResolvedValue(undefined);
    await $onEmit(emitContextFor(runner.program, { "output-file": "fixed.yaml" }));
    expect(runner.program.diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/duplicate-output-file",
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("suppresses all successful writes under noEmit without suppressing warnings", async () => {
    const runner = await AsyncAPITester.createInstance();
    await runner.compile(
      '@service namespace A { @channel("empty") interface Empty {} } @service namespace B {}',
      { compilerOptions: { noEmit: true } },
    );
    const writeFile = vi.spyOn(runner.program.host, "writeFile").mockResolvedValue(undefined);
    await $onEmit(emitContextFor(runner.program, {}));
    expect(runner.program.diagnostics.map(({ code }) => code)).toContain(
      "tsp-asyncapi/channel-no-messages",
    );
    expect(writeFile).not.toHaveBeenCalled();
  });
});
