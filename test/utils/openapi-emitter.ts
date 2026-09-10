import { createTester, expectDiagnosticEmpty } from "@typespec/compiler/testing";
import type { OpenAPIDocument3_1 } from "@typespec/openapi3";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { byCodePoint } from "./sort.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const tester = createTester(ROOT, {
  libraries: ["@typespec/http", "@typespec/openapi", "@typespec/openapi3"],
}).emit("@typespec/openapi3", {
  "openapi-versions": ["3.1.0"],
  "file-type": ["yaml", "json"],
  "output-file": "openapi.{file-type}",
});

/**
 * Compile real HTTP source without injecting imports or stripping its entrypoint.
 * Record input preserves explicit imports between files, including unused files.
 */
export async function emitOpenAPI31(source: string | Record<string, string>): Promise<{
  document: OpenAPIDocument3_1;
  yaml: string;
  json: string;
}> {
  const [result, diagnostics] = await tester.compileAndDiagnose(source);
  expectDiagnosticEmpty(diagnostics);
  const names = Object.keys(result.outputs).sort(byCodePoint);
  if (names.join(",") !== "openapi.json,openapi.yaml") {
    throw new Error(`Expected exactly openapi.json and openapi.yaml, got ${names.join(",")}.`);
  }
  const json = result.outputs["openapi.json"];
  const yaml = result.outputs["openapi.yaml"];
  const parsed = JSON.parse(json) as { openapi?: string };
  if (parsed.openapi !== "3.1.0") {
    throw new Error(`Expected OpenAPI 3.1.0, got ${String(parsed.openapi)}.`);
  }
  // Parsing both also refuses malformed serialization before a caller compares them.
  parse(yaml);
  return { document: parsed as OpenAPIDocument3_1, yaml, json };
}
