import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * What the package check reads, and what the workspace installs.
 *
 * `check:package` packs a tarball into `temp` and hands it to `attw`. The
 * directory is not emptied first, so a tarball of an older version stays
 * there. The glob then matches more than one file and `attw` reads the wrong
 * tarball, which reports the types of a version nobody is releasing.
 */

/** The workspace root, as a path from this file. */
const ROOT = new URL("../../../", import.meta.url);

/** Every package the workspace publishes. */
const PACKAGES = ["tsp-asyncapi-core", "tsp-asyncapi", "tsp-avro"];

/** The parts of a manifest these cases read. */
interface Manifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

describe("Unit: the package check", () => {
  it.each(PACKAGES)("removes the old tarballs of %s before it packs", async (name) => {
    const manifest = await manifestOf(`packages/${name}/package.json`);
    const script = manifest.scripts?.["check:package"] ?? "";

    // The removal comes before the pack, so exactly one tarball is left for
    // `attw` to read.
    expect(script.indexOf("rimraf"), script).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("rimraf")).toBeLessThan(script.indexOf("pnpm pack"));
  });
});

describe("Unit: the declared dependencies", () => {
  it.each(PACKAGES)("aligns %s with the supported compiler and Node baseline", async (name) => {
    const manifest = await manifestOf(`packages/${name}/package.json`);
    expect(manifest.peerDependencies?.["@typespec/compiler"]).toBe("^1.16.0");
    expect(manifest.devDependencies?.["@typespec/compiler"]).toBe("^1.16.0");
    expect(manifest.engines?.node).toBe(">=22.0.0");
  });

  it("pins compatible HTTP and protobuf tooling", async () => {
    const root = await manifestOf("package.json");
    expect(root.devDependencies?.["@typespec/compiler"]).toBe("^1.16.0");
    expect(root.engines?.node).toBe(">=22.0.0");
    for (const name of ["http", "openapi", "openapi3"]) {
      expect(root.devDependencies?.[`@typespec/${name}`]).toBe("1.16.0");
    }
    expect(root.devDependencies?.["@typespec/protobuf"]).toBe("0.86.0");
    const emitter = await manifestOf("packages/tsp-asyncapi/package.json");
    expect(emitter.peerDependencies?.["@typespec/protobuf"]).toBe("0.86.x");
    expect(emitter.devDependencies?.["@typespec/protobuf"]).toBe("0.86.0");
  });

  /**
   * `yaml` carries its own type declarations. `@types/yaml` is a stub that
   * says so and nothing else, and DefinitelyTyped marks it deprecated. It
   * was declared here and imported nowhere.
   */
  it("declares no type stub for a package that types itself", async () => {
    for (const path of ["package.json", ...PACKAGES.map((n) => `packages/${n}/package.json`)]) {
      const manifest = await manifestOf(path);
      expect(manifest.dependencies?.["@types/yaml"], path).toBeUndefined();
      expect(manifest.devDependencies?.["@types/yaml"], path).toBeUndefined();
    }
  });
});

/**
 * One manifest of the workspace.
 *
 * @param path - The manifest path, from the workspace root
 * @returns The parsed manifest
 */
async function manifestOf(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(new URL(path, ROOT), "utf8")) as Manifest;
}
