import { describe, expect, it } from "vitest";
import { listServices, type DecoratorContext, type Program, type Type } from "@typespec/compiler";
import { expectDiagnosticEmpty, mockFile, t } from "@typespec/compiler/testing";
import { addExtension, getExtensions } from "tsp-asyncapi-core";
import { AsyncAPITester } from "#core/testing.js";
import { reportExtensionProblems, resolveExtensions } from "#core/resolve/extensions.js";
import { buildAsyncAPIDocument } from "#emitter/pipeline.js";
import { diagnosticsWith, findDiagnostic, targetText } from "../../utils/diagnostics.js";

const ExtensionTester = AsyncAPITester.files({
  "writer.js": mockFile.js({
    $writeExtension(context: DecoratorContext, target: Type, key: string, value: unknown) {
      addExtension(context, target, key, value, {
        keyTarget: context.getArgumentTarget(0) ?? target,
        valueTarget: context.getArgumentTarget(1) ?? target,
      });
    },
    $profile(context: DecoratorContext, target: Type, value: unknown) {
      addExtension(context, target, "x-profile", value, {
        keyTarget: context.getArgumentTarget(0) ?? target,
        valueTarget: context.getArgumentTarget(0) ?? target,
      });
    },
  }),
  "writer.tsp": `
    import "./writer.js";
    extern dec writeExtension(target: unknown, key: valueof string, value: valueof unknown);
    extern dec profile(target: unknown, value: valueof unknown);
  `,
}).import("./writer.tsp");

function contextFor(program: Program, target: Type): DecoratorContext {
  const unexpectedCall = () => {
    throw new Error("The writer must not call another decorator or function.");
  };
  return {
    program,
    decoratorTarget: target,
    getArgumentTarget: () => undefined,
    call: unexpectedCall,
    callDecorator: unexpectedCall,
    callFunction: unexpectedCall,
  };
}

describe("Unit: public extension writer", () => {
  it("matches raw output at all four placements, including marshalled scalars", async () => {
    const documents = [];
    for (const decorator of ["extension", "writeExtension"]) {
      const { program } = await ExtensionTester.compile(`
        @service(#{ title: "Orders" })
        @${decorator}("x-owner", #{ name: "team", flags: #[true, false, null] })
        namespace Test;

        @message
        @${decorator}("x-date", #{ at: utcDateTime.fromISO("2026-01-01T00:00:00Z") })
        model Event { id: string; }

        @channel("orders")
        @${decorator}("x-values", #[0, "", 3.5, #{ nested: #["a", "b"] }])
        interface Orders {
          @send
          @${decorator}("x-config", #{ enabled: false, nested: #{ count: 0 } })
          op publish(event: Event): void;
        }
      `);
      documents.push(await buildAsyncAPIDocument(program, listServices(program)[0], {}));
      expectDiagnosticEmpty(program.diagnostics);
    }
    expect(documents[1]).toEqual(documents[0]);
    expect(documents[1].info["x-owner"]).toEqual({
      name: "team",
      flags: [true, false, null],
    });
  });

  it("copies nested JSON on both write and read without retaining shared references", async () => {
    const { Target, program } = await ExtensionTester.compile(t.code`
      model ${t.model("Target")} {}
    `);
    const shared = { flags: [true], detail: { count: 1 } };
    const value = { first: shared, second: shared, omitted: undefined };
    addExtension(contextFor(program, Target), Target, "x-config", value);
    shared.flags.push(false);
    shared.detail.count = 9;

    const expected = {
      first: { flags: [true], detail: { count: 1 } },
      second: { flags: [true], detail: { count: 1 } },
    };
    const extensions = getExtensions(program, Target);
    expect(extensions.get("x-config")).toEqual(expected);
    const read = extensions.get("x-config") as typeof value;
    read.first.flags.push(false);
    read.first.detail.count = 42;
    expect(read.second).toEqual(expected.second);
    (extensions as Map<string, unknown>).clear();

    expect(getExtensions(program, Target).get("x-config")).toEqual(expected);
    expect(resolveExtensions(program, Target)["x-config"]).toEqual(expected);
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("preserves an own __proto__ JSON member supplied by a companion", async () => {
    const { Target, program } = await ExtensionTester.compile(t.code`
      model ${t.model("Target")} {}
    `);
    const value = Object.fromEntries([["__proto__", { kept: true }]]);
    addExtension(contextFor(program, Target), Target, "x-config", value);
    const read = getExtensions(program, Target).get("x-config") as Record<string, unknown>;
    expect(Object.getOwnPropertyDescriptor(read, "__proto__")?.value).toEqual({ kept: true });
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
  });

  it("records on actual cloned targets even when their names and source nodes are identical", async () => {
    const { Target, program } = await ExtensionTester.compile(t.code`
      model ${t.model("Target")} {}
    `);
    const firstClone = program.checker.cloneType(Target);
    const secondClone = program.checker.cloneType(Target);
    const context = contextFor(program, Target);
    addExtension(context, Target, "x-view", { view: "original" });
    addExtension(context, firstClone, "x-view", { view: "first" });
    addExtension(context, secondClone, "x-view", { view: "second" });

    expect(firstClone.node).toBe(Target.node);
    expect(firstClone.name).toBe(Target.name);
    expect(getExtensions(program, Target).get("x-view")).toEqual({ view: "original" });
    expect(getExtensions(program, firstClone).get("x-view")).toEqual({ view: "first" });
    expect(getExtensions(program, secondClone).get("x-view")).toEqual({ view: "second" });
    reportExtensionProblems(program, new Set([Target, firstClone, secondClone]));
    expectDiagnosticEmpty(program.diagnostics);
  });

  it.each(["owner", "x-", "x-has space", "X-owner", "x-owner/path"])(
    "reports the same invalid key and source argument for raw and writer: %s",
    async (key) => {
      const [{ Raw, Written, program }, diagnostics] =
        await ExtensionTester.compileAndDiagnose(t.code`
          @extension("${key}", "value")
          model ${t.model("Raw")} {}
          @writeExtension("${key}", "value")
          model ${t.model("Written")} {}
        `);
      const problems = diagnosticsWith(diagnostics, "invalid-extension-key");
      expect(problems).toHaveLength(2);
      expect(problems.map(targetText)).toEqual([`"${key}"`, `"${key}"`]);
      expect(problems.every((problem) => problem.severity === "error")).toBe(true);
      expect(getExtensions(program, Raw).size).toBe(0);
      expect(getExtensions(program, Written).size).toBe(0);
    },
  );

  it.each([
    "ipv4.fromBytes(1, 2, 3, 4)",
    '#[ipv4.fromBytes(1, 2, 3, 4), "kept"]',
    '#{ bad: ipv4.fromBytes(1, 2, 3, 4), kept: "value" }',
    'duration.fromISO("nonsense")',
  ])("reports serialization failures at the value argument: %s", async (value) => {
    const [{ Raw, Written, program }, diagnostics] =
      await ExtensionTester.compileAndDiagnose(t.code`
        scalar ipv4 extends string {
          init fromBytes(a: uint8, b: uint8, c: uint8, d: uint8);
        }
        @extension("x-value", ${value})
        model ${t.model("Raw")} {}
        @writeExtension("x-value", ${value})
        model ${t.model("Written")} {}
      `);
    const problems = diagnosticsWith(diagnostics, "unserializable-extension");
    expect(problems).toHaveLength(2);
    expect(problems.map(targetText)).toEqual([value, value]);
    expect(problems.every((problem) => problem.severity === "warning")).toBe(true);
    expect(getExtensions(program, Raw).size).toBe(0);
    expect(getExtensions(program, Written).size).toBe(0);
  });

  it("rejects non-JSON JavaScript values without recording a partial value", async () => {
    const { Target, Source, program } = await ExtensionTester.compile(t.code`
      model ${t.model("Target")} {}
      model ${t.model("Source")} {}
    `);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    const invalid = [
      undefined,
      NaN,
      Infinity,
      -Infinity,
      1n,
      Symbol("bad"),
      () => true,
      [undefined],
      { nested: [undefined] },
      { nested: { bad: () => true } },
      new Date(0),
      new Map([["key", "value"]]),
      new Set(["value"]),
      cyclic,
      { nested: cyclic },
    ];
    for (const value of invalid) {
      addExtension(contextFor(program, Target), Target, "x-bad", value, {
        valueTarget: Source,
      });
    }
    const problems = diagnosticsWith(program.diagnostics, "unserializable-extension");
    expect(problems).toHaveLength(invalid.length);
    expect(problems.every((problem) => problem.target === Source)).toBe(true);
    expect(getExtensions(program, Target).size).toBe(0);
  });

  it("falls back to the actual target for omitted diagnostic argument targets", async () => {
    const { Target, Source, program } = await ExtensionTester.compile(t.code`
      model ${t.model("Target")} {}
      model ${t.model("Source")} {}
    `);
    const context = contextFor(program, Source);
    addExtension(context, Target, "invalid", {});
    addExtension(context, Target, "x-bad", undefined);
    expect(findDiagnostic(program.diagnostics, "invalid-extension-key").target).toBe(Target);
    expect(findDiagnostic(program.diagnostics, "unserializable-extension").target).toBe(Target);
  });

  it.each([
    {
      decorators: '@extension("x-profile", #{ raw: true }) @profile(#{ typed: true })',
      winner: { raw: true },
      losingTarget: "#{ typed: true }",
    },
    {
      decorators: '@profile(#{ typed: true }) @extension("x-profile", #{ raw: true })',
      winner: { typed: true },
      losingTarget: '"x-profile"',
    },
  ])(
    "keeps the first source value without merging: $decorators",
    async ({ decorators, winner, losingTarget }) => {
      const { Target, program } = await ExtensionTester.compile(t.code`
      ${decorators}
      model ${t.model("Target")} {}
    `);
      expect(getExtensions(program, Target).get("x-profile")).toEqual(winner);
      expect(resolveExtensions(program, Target)["x-profile"]).toEqual(winner);
      expectDiagnosticEmpty(program.diagnostics);

      reportExtensionProblems(program, new Set([Target]));
      const problems = diagnosticsWith(program.diagnostics, "duplicate-extension-key");
      expect(problems).toHaveLength(1);
      expect(problems[0].severity).toBe("error");
      expect(targetText(problems[0])).toBe(losingTarget);
    },
  );

  it("orders raw and companion augments by source file, not execution or filename", async () => {
    const { Target, program } = await ExtensionTester.files({
      "earlier-name.tsp": "@@profile(Target, #{ imported: true });",
    }).import("./earlier-name.tsp").compile(t.code`
        @extension("x-profile", #{ main: true })
        model ${t.model("Target")} {}
      `);
    expect(getExtensions(program, Target).get("x-profile")).toEqual({ main: true });
    reportExtensionProblems(program, new Set([Target]));
    const problem = findDiagnostic(program.diagnostics, "duplicate-extension-key");
    expect(targetText(problem)).toBe("#{ imported: true }");
  });

  it("reports a raw-plus-writer collision once when the target emits info and a channel", async () => {
    const { program } = await ExtensionTester.compile(`
      @service(#{ title: "Orders" })
      @channel("orders")
      @extension("x-profile", #{ raw: true })
      @profile(#{ typed: true })
      namespace Test;
    `);
    const document = await buildAsyncAPIDocument(program, listServices(program)[0], {});
    expect(document.info["x-profile"]).toEqual({ raw: true });
    expect(document.channels?.orders).toMatchObject({ "x-profile": { raw: true } });
    const problems = diagnosticsWith(program.diagnostics, "duplicate-extension-key");
    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe("error");
    expect(targetText(problems[0])).toBe("#{ typed: true }");
  });

  it("does not mistake a repeated augment on a reopened namespace for a collision", async () => {
    const { Target, program } = await ExtensionTester.compile(t.code`
      namespace ${t.namespace("Target")} {}
      namespace Target {}
      @@profile(Target, #{ once: true });
    `);
    expect(getExtensions(program, Target).get("x-profile")).toEqual({ once: true });
    reportExtensionProblems(program, new Set([Target]));
    expectDiagnosticEmpty(program.diagnostics);
  });

  it("leaves misplaced targets and their collisions to the existing emitter checks", async () => {
    const { program } = await ExtensionTester.compile(`
      @service(#{ title: "Orders" })
      namespace Test;

      @profile(#{ first: true })
      @extension("x-profile", #{ second: true })
      model Unused {}
    `);
    expectDiagnosticEmpty(program.diagnostics);
    const document = await buildAsyncAPIDocument(program, listServices(program)[0], {});
    const problems = diagnosticsWith(program.diagnostics, "extension-target-not-emitted");
    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe("warning");
    expect(diagnosticsWith(program.diagnostics, "duplicate-extension-key")).toHaveLength(0);
    expect(JSON.stringify(document)).not.toContain("x-profile");
  });
});
