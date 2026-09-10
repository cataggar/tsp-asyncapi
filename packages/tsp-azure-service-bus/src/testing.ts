import { getDirectoryPath, normalizePath } from "@typespec/compiler";
import { createTester } from "@typespec/compiler/testing";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function findPackageRoot(fromUrl: string): string {
  let dir = getDirectoryPath(normalizePath(fileURLToPath(fromUrl)));
  while (!existsSync(`${dir}/package.json`)) {
    const parent = getDirectoryPath(dir);
    if (parent === dir) {
      throw new Error(`Cannot find package.json above ${fromUrl}`);
    }
    dir = parent;
  }
  return dir;
}

/**
 * Tester with the core and companion libraries imported and the `AsyncAPI`
 * and `Azure.ServiceBus` namespaces in scope. No emitter is registered.
 *
 * @public
 */
export const ServiceBusTester = createTester(findPackageRoot(import.meta.url), {
  libraries: ["tsp-asyncapi-core", "tsp-azure-service-bus"],
})
  .importLibraries()
  .using("AsyncAPI", "Azure.ServiceBus");
