import { describe, expect, it } from "vitest";
import { AsyncAPITester } from "#emitter/testing.js";
import { planDocumentOutputs, type DocumentOutputInput } from "#emitter/document-output.js";

async function plan(
  identities: readonly Partial<DocumentOutputInput<number>>[],
  template?: string,
) {
  const { program } = await AsyncAPITester.compile("");
  const outputs = planDocumentOutputs(
    program,
    "/out",
    identities.map((identity, index) => ({
      document: index,
      multipleServices: false,
      fileType: "yaml",
      target: program.getGlobalNamespaceType(),
      ...identity,
    })),
    template,
  );
  return { outputs, diagnostics: program.diagnostics };
}

describe("Unit: complete document output planning", () => {
  it.each([
    [{}, "asyncapi.yaml"],
    [{ serviceName: "App" }, "asyncapi.yaml"],
    [{ serviceName: "App", fileType: "json" }, "asyncapi.json"],
    [{ serviceName: "Group.App", multipleServices: true }, "asyncapi.Group.App.yaml"],
    [{ serviceName: "App", version: "2025-01" }, "asyncapi.2025-01.yaml"],
    [{ serviceName: "App", multipleServices: true, version: "v1" }, "asyncapi.App.v1.yaml"],
  ] as const)("uses stable identity inputs %j", async (identity, filename) => {
    const { outputs, diagnostics } = await plan([identity]);
    expect(diagnostics).toEqual([]);
    expect(outputs).toEqual([{ document: 0, filename, path: `/out/${filename}` }]);
  });

  it("does not rename outputs when either selector reduces the original matrix", async () => {
    const identities = ["A", "B"].flatMap((serviceName) =>
      ["v1", "v2"].map((version) => ({ serviceName, version, multipleServices: true })),
    );
    const complete = await plan(identities);
    const selected = await plan([identities[3]]);
    expect(complete.outputs?.map(({ filename }) => filename)).toEqual([
      "asyncapi.A.v1.yaml",
      "asyncapi.A.v2.yaml",
      "asyncapi.B.v1.yaml",
      "asyncapi.B.v2.yaml",
    ]);
    expect(selected.outputs?.[0].filename).toBe(complete.outputs?.[3].filename);
  });

  it("supports directories, mandatory service names, and omitted optional separators", async () => {
    const { outputs } = await plan(
      [{ serviceName: "Group.App" }],
      "{service-name}/{version}/asyncapi.{file-type}",
    );
    expect(outputs?.[0]).toEqual({
      document: 0,
      filename: "Group.App/asyncapi.yaml",
      path: "/out/Group.App/asyncapi.yaml",
    });
  });

  it.each([
    ["a/b\\c %", "a%2Fb%5Cc%20%25"],
    ["v:1?", "v%3A1%3F"],
    ["\u4e2d", "%E4%B8%AD"],
    ["CON", "%43ON"],
    ["NUL.json", "%4EUL.json"],
    ["..", "%2E%2E"],
    ["v1.", "v1%2E"],
    ["", "%EMPTY"],
    ["\ud800", "%uD800"],
    ["\ufffd", "%EF%BF%BD"],
  ])("encodes a portable token for %j", async (version, encoded) => {
    const { outputs, diagnostics } = await plan([{ version }]);
    expect(diagnostics).toEqual([]);
    expect(outputs?.[0].filename).toBe(`asyncapi.${encoded}.yaml`);
  });

  it.each(["custom.yaml", "sub/../custom.yaml", "sub\\..\\custom.yaml"])(
    "rejects literal collisions for %s",
    async (template) => {
      const { outputs, diagnostics } = await plan(
        [{ serviceName: "A" }, { serviceName: "B" }],
        template,
      );
      expect(outputs).toBeUndefined();
      expect(diagnostics.map(({ code }) => code)).toEqual(["tsp-asyncapi/duplicate-output-file"]);
    },
  );

  it("rejects case-insensitive path collisions rather than suffixing a counter", async () => {
    const { outputs, diagnostics } = await plan([
      { serviceName: "App", multipleServices: true },
      { serviceName: "app", multipleServices: true },
    ]);
    expect(outputs).toBeUndefined();
    expect(diagnostics.map(({ code }) => code)).toEqual(["tsp-asyncapi/duplicate-output-file"]);
  });

  it.each([
    "",
    ".",
    "..",
    "dir/.",
    "dir\\..",
    "dir/",
    "{version}",
    "{unknown}.yaml",
    "{service-name",
    "{file-type}}",
  ])("refuses invalid template %j", async (template) => {
    const { outputs, diagnostics } = await plan([{}], template);
    expect(outputs).toBeUndefined();
    expect(diagnostics.map(({ code }) => code)).toEqual(["tsp-asyncapi/invalid-output-file"]);
  });
});
