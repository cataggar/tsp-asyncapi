import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncAPITester } from "#emitter/testing.js";
import {
  emitDocument,
  emitDocumentWithDiagnostics,
  emitDocumentsWithDiagnostics,
  emitOutputsWithDiagnostics,
} from "../../utils/test-host.js";

afterEach(() => vi.restoreAllMocks());

describe("Unit: document test host", () => {
  it("keeps actual custom filenames and does not implicitly wrap multi-document sources", async () => {
    const result = await emitDocumentsWithDiagnostics("@message model Event { id: string; }", {
      "output-file": "nested/custom.contract",
      "file-type": "json",
    });
    expect(Object.keys(result.outputs)).toEqual(["nested/custom.contract"]);
    expect(Object.keys(result.documents)).toEqual(["nested/custom.contract"]);
    expect(result.documents["nested/custom.contract"].info.title).toBe("AsyncAPI Document");
    expect(JSON.parse(result.outputs["nested/custom.contract"])).toEqual(
      result.documents["nested/custom.contract"],
    );
  });

  it("preserves all outputs and rejects a single-document read of multiple files", async () => {
    const tester = AsyncAPITester.emit("tsp-asyncapi");
    const compile = tester.compileAndDiagnose.bind(tester);
    vi.spyOn(tester, "compileAndDiagnose").mockImplementation(async (...args) => {
      const [result, diagnostics] = await compile(...args);
      return [
        {
          ...result,
          outputs: {
            "first.yaml": result.outputs["asyncapi.yaml"],
            "nested/second.yaml": result.outputs["asyncapi.yaml"],
          },
        },
        diagnostics,
      ];
    });
    vi.spyOn(AsyncAPITester, "emit").mockReturnValue(tester);

    const result = await emitDocumentsWithDiagnostics("");
    expect(Object.keys(result.outputs)).toEqual(["first.yaml", "nested/second.yaml"]);
    expect(Object.keys(result.documents)).toEqual(["first.yaml", "nested/second.yaml"]);
    await expect(emitDocumentWithDiagnostics("")).rejects.toThrow(
      "Expected one AsyncAPI output, received 2",
    );
    await expect(emitDocument("")).rejects.toThrow("Use emitDocumentsWithDiagnostics");
  });

  it("retains zero outputs and diagnostics without making the clean wrapper succeed", async () => {
    const raw = await emitOutputsWithDiagnostics("@notARealDecorator model Event {}");
    expect(raw.outputs).toEqual({});
    expect(raw.diagnostics.length).toBeGreaterThan(0);
    const result = await emitDocumentWithDiagnostics("@notARealDecorator model Event {}");
    expect(result.doc).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("preserves the single-output helper's implicit TestService", async () => {
    const document = await emitDocument("@message model Event { id: string; }");
    expect(document.info.title).toBe("TestService");
  });
});
