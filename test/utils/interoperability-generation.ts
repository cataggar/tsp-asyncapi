import { compile, formatDiagnostic, NodeHost, resolveCompilerOptions } from "@typespec/compiler";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INTEROPERABILITY_ROOT = fileURLToPath(
  new URL("../../examples/19-http-service-bus/", import.meta.url),
);
const APPLICATIONS = ["", "processor", "fulfillment"] as const;
export const INTEROPERABILITY_OUTPUTS = [
  "asyncapi.yaml",
  "asyncapi.json",
  "processor/asyncapi.yaml",
  "processor/asyncapi.json",
  "fulfillment/asyncapi.yaml",
  "fulfillment/asyncapi.json",
  "http/openapi.yaml",
  "http/openapi.json",
] as const;

/**
 * Compile the actual entrypoints/configs, capturing only the eight declared files.
 * No transformed fixture source, shared service imports, or disk staging directory.
 */
export async function compileInteroperability(): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  const variants = [
    ...APPLICATIONS.flatMap((directory) =>
      ["yaml", "json"].map((format) => ({
        directory,
        emitter: "tsp-asyncapi",
        options: { "file-type": format, "output-file": `asyncapi.${format}` },
      })),
    ),
    { directory: "http", emitter: "@typespec/openapi3", options: {} },
  ];
  const host = {
    ...NodeHost,
    mkdirp: () => Promise.resolve(undefined),
    writeFile: (path: string, content: string) => {
      const name = relative(INTEROPERABILITY_ROOT, path).replaceAll("\\", "/");
      if (!INTEROPERABILITY_OUTPUTS.some((expected) => expected === name) || files.has(name)) {
        throw new Error(`Unexpected or repeated interoperability output: ${name}`);
      }
      files.set(name, content);
      return Promise.resolve();
    },
  };
  for (const variant of variants) {
    const cwd = join(INTEROPERABILITY_ROOT, variant.directory);
    const entrypoint = join(cwd, "main.tsp");
    const [options, configDiagnostics] = await resolveCompilerOptions(host, {
      cwd,
      entrypoint,
      configPath: join(cwd, "tspconfig.yaml"),
      overrides: { options: { [variant.emitter]: variant.options } },
    });
    if (configDiagnostics.length) {
      throw new Error(
        configDiagnostics.map((diagnostic) => formatDiagnostic(diagnostic)).join("\n"),
      );
    }
    const program = await compile(host, entrypoint, options);
    const warnings = program.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "tsp-azure-service-bus/deployment-unverified" &&
        diagnostic.severity === "warning",
    );
    const expectedWarnings = variant.emitter === "tsp-asyncapi" ? 1 : 0;
    if (warnings.length !== expectedWarnings || program.diagnostics.length !== warnings.length) {
      throw new Error(
        program.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic)).join("\n") ||
          `Expected ${String(expectedWarnings)} explicit deployment-unverified warning(s).`,
      );
    }
  }
  if (files.size !== INTEROPERABILITY_OUTPUTS.length) {
    throw new Error(`Expected eight interoperability documents, got ${String(files.size)}.`);
  }
  return files;
}

/** Verify exact bytes and the artifact set; check mode never rewrites a baseline. */
export async function generateInteroperability(check: boolean): Promise<void> {
  const files = await compileInteroperability();
  for (const [name, content] of files) {
    const path = join(INTEROPERABILITY_ROOT, name);
    if (check) {
      if ((await readFile(path, "utf8")) !== content) {
        throw new Error(`Stale ${name}; run pnpm examples:interop and review the diff.`);
      }
    } else {
      await writeFile(path, content);
    }
  }
  for (const directory of [...APPLICATIONS, "http"]) {
    const names = await readdir(join(INTEROPERABILITY_ROOT, directory));
    const unexpected = names.filter(
      (name) =>
        /^(?:openapi|asyncapi).*\.(?:yaml|json)$/.test(name) &&
        !INTEROPERABILITY_OUTPUTS.some(
          (expected) => expected === [directory, name].filter(Boolean).join("/"),
        ),
    );
    if (unexpected.length)
      throw new Error(`Unexpected generated documents: ${unexpected.join(", ")}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Usage: pnpm examples:interop [--check]");
  }
  await generateInteroperability(args[0] === "--check");
  console.log(
    `Eight interoperability documents ${args[0] === "--check" ? "verified" : "generated"}.`,
  );
  console.log(
    "Service Bus deployment requirements remain unverified; no Azure connection was made.",
  );
}
