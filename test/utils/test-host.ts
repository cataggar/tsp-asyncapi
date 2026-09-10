import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import type { Diagnostic, Program } from "@typespec/compiler";
import { AsyncAPITester } from "#emitter/testing.js";
import { PACKAGE_NAME } from "#emitter/lib.js";
import { buildAsyncAPIDocument } from "#emitter/pipeline.js";
import type { AsyncAPIDocument } from "#emitter/types/index.js";
import yaml from "yaml";

/**
 * Source for a test compilation. A string is the whole of `main.tsp`. A
 * record is a set of files, keyed by name, for a case where a declaration
 * spans files, such as a namespace opened in more than one of them.
 */
export type TestSource = string | Record<string, string>;

/**
 * The entry file of a test compilation. The tester wraps it with the
 * library import and the `using` statement, and the compiler starts here.
 */
const ENTRY_FILE = "main.tsp";

/**
 * Builds the tester for one source.
 *
 * A multi-file case imports every extra file from the entry file, in the
 * order the record lists them. The imports cannot live in the entry file's
 * own text, because the tester's `using` statement goes above it and
 * TypeSpec requires every import to come first.
 *
 * @param code - The source of the compilation
 * @param options - The emitter options
 * @returns The tester to compile with
 */
function createTester(code: TestSource, options: Record<string, unknown>) {
  const tester = AsyncAPITester.emit(PACKAGE_NAME, options);
  if (typeof code === "string") return tester;
  const imports = Object.keys(code)
    .filter((name) => name !== ENTRY_FILE)
    .map((name) => `./${name}`);
  return imports.length > 0 ? tester.import(...imports) : tester;
}

/**
 * Compiles one source and retains every actual emitted filename.
 *
 * Multi-document fixtures declare their own services by default. No filename
 * is inferred from a service name, version, or emitter option.
 *
 * @param code - The source of the compilation
 * @param options - The emitter options
 * @param includeService - Whether to wrap a single-file source in a service
 * @returns All emitted text, every diagnostic, and the original program
 */
export async function emitOutputsWithDiagnostics(
  code: TestSource,
  options: Record<string, unknown> = {},
  includeService = false,
) {
  // Only a single-file source gets this wrapper added. A multi-file case
  // must declare its own service, since only its author knows which file
  // should hold it.
  const fullCode =
    typeof code === "string" && includeService && !code.includes("@service")
      ? `@service(#{ title: "TestService" }) namespace Test;\n${code}`
      : code;

  const [result, diagnostics] = await createTester(code, options).compileAndDiagnose(fullCode);

  const outputs: Readonly<Record<string, string>> = { ...result.outputs };
  return { outputs, diagnostics, program: result.program };
}

/** Parses all emitted documents, retaining the raw outputs and actual filenames. */
export async function emitDocumentsWithDiagnostics(
  code: TestSource,
  options: Record<string, unknown> = {},
  includeService = false,
): Promise<{
  documents: Readonly<Record<string, AsyncAPIDocument>>;
  outputs: Readonly<Record<string, string>>;
  diagnostics: readonly Diagnostic[];
  program: Program;
}> {
  const result = await emitOutputsWithDiagnostics(code, options, includeService);
  const documents: Record<string, AsyncAPIDocument> = {};
  for (const [filename, content] of Object.entries(result.outputs)) {
    // Custom output filenames need not have the selected serialization's extension.
    const parsed: unknown =
      options["file-type"] === "json" ? JSON.parse(content) : yaml.parse(content);
    documents[filename] = parsed as AsyncAPIDocument;
  }
  return { ...result, documents };
}

/**
 * Emits one source and parses the document, keeping every diagnostic.
 *
 * The program comes back alongside the document, because a decorator that
 * only records state needs it read back directly. An error also stops the
 * emitter, so `doc` is null then, and a caller checking diagnostics must
 * handle that.
 *
 * @param code - The source of the compilation
 * @param options - The emitter options
 * @param includeService - Whether to wrap a single-file source in a service
 * @returns The parsed document or null, every diagnostic, and the program
 */
export async function emitDocumentWithDiagnostics(
  code: TestSource,
  options: Record<string, unknown> = {},
  includeService = true,
): Promise<{
  doc: AsyncAPIDocument | null;
  diagnostics: readonly Diagnostic[];
  program: Program;
}> {
  const { documents, diagnostics, program } = await emitDocumentsWithDiagnostics(
    code,
    options,
    includeService,
  );

  const filenames = Object.keys(documents);
  if (filenames.length > 1) {
    throw new Error(
      `Expected one AsyncAPI output, received ${String(filenames.length)}: ${filenames.join(", ")}. ` +
        "Use emitDocumentsWithDiagnostics for multiple documents.",
    );
  }
  return { doc: filenames.length === 0 ? null : documents[filenames[0]], diagnostics, program };
}

/**
 * Emits one source that is meant to compile clean, and returns its document.
 *
 * This asserts the compilation reported nothing and the emitter wrote a
 * file, so a test about document content never has to check either. A null
 * document reaching such a test means a broken fixture, not a real outcome.
 *
 * @param code - The source of the compilation
 * @param options - The emitter options
 * @returns The parsed document
 */
export async function emitDocument(
  code: TestSource,
  options: Record<string, unknown> = {},
): Promise<AsyncAPIDocument> {
  const { doc, diagnostics } = await emitDocumentWithDiagnostics(code, options);
  expectDiagnosticEmpty(diagnostics);
  if (doc === null) {
    throw new Error(
      "The emitter wrote no output file, so there is no document to read. " +
        "A test that expects this should use emitDocumentWithDiagnostics.",
    );
  }
  return doc;
}

/**
 * Builds the document from a program the test compiled itself.
 *
 * Fills in the two arguments that are the same at every call site: no
 * explicit service and no emitter options. Spelled out, they were the
 * longest repetition in the suite and said nothing about the case under
 * test.
 *
 * A test that needs to name the service calls `buildAsyncAPIDocument`
 * directly.
 *
 * @param program - The compiled program
 * @returns The built document
 */
export function documentFrom(program: Program): Promise<AsyncAPIDocument> {
  return buildAsyncAPIDocument(program, undefined, {});
}

/**
 * Builds a document from source without writing a file.
 *
 * The emitter writes nothing once an error is reported, so a test about an
 * error cannot use `emitDocumentWithDiagnostics` to see what the document
 * still holds.
 *
 * A binding missing a field its specification requires is exactly that
 * case. The diagnostic promises the binding was dropped and the rest of
 * the document survived, and only the document itself can confirm that.
 *
 * This calls the pipeline directly, so it runs the `src` copy of the
 * builder. The decorators still run from `dist`, which is where the
 * compiler loads them from.
 *
 * @param code - The source of the compilation
 * @returns The built document and every diagnostic the compilation reported
 */
export async function buildAsyncAPIWithDiagnostics(code: string) {
  const runner = await AsyncAPITester.createInstance();
  const [, diagnostics] = await runner.compileAndDiagnose(code);
  return { doc: await documentFrom(runner.program), diagnostics };
}
