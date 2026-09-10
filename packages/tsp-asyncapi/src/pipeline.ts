/**
 * The three stages, in order.
 *
 * ```
 * resolve    program + decorator state → AsyncAPIService
 * lower      AsyncAPIService (+program) → AsyncAPIDocument
 * serialize  AsyncAPIDocument → YAML or JSON
 * ```
 *
 * Each stage hands the next a value. Nothing is shared and nothing is
 * mutable across the boundary, so a program can be resolved and lowered more
 * than once. That is what emitting one document per version, or per service,
 * needs.
 */

import { Program, Service } from "@typespec/compiler";
import { getInfo, reportDiagnostic } from "tsp-asyncapi-core";
import type { AsyncAPIEmitterOptions } from "./emitter-options.js";
import {
  BindingPlacements,
  emptySchemaArtifacts,
  resolveService,
  type SchemaArtifactIndex,
} from "tsp-asyncapi-core/unstable";
import { lowerDocument } from "./lower/document.js";
import { AsyncAPIDocument } from "./types/index.js";
import { createDocumentContext, type DocumentContext } from "./document-context.js";

/**
 * Runs resolve and lower over one program.
 *
 * The result is a promise, and the two stages inside are synchronous. The
 * promise is part of the contract, not of the work. A provider of generated
 * schemas runs an external emitter, which is asynchronous. The stages will
 * read what it produced. Every caller already awaits, so the step that gives
 * the body work to await changes this file alone.
 *
 * @param program - The compiled program
 * @param service - The document's service, if the program has one
 * @param options - The emitter options reaching the document
 * @param artifacts - Schemas a preview feature generated; empty when none is on
 * @returns The document object tree
 * @internal
 */
// The body awaits nothing yet, but `async` keeps the signature honest: a
// throw from either stage reaches the caller as a rejection, matching the
// return type.
export async function buildAsyncAPIDocument(
  program: Program,
  service: Service | undefined,
  options: AsyncAPIEmitterOptions,
  artifacts: SchemaArtifactIndex = emptySchemaArtifacts,
): Promise<AsyncAPIDocument> {
  return buildDocumentFromContext(createDocumentContext(program, service), options, artifacts);
}

/** Builds from one selected live graph, with fresh resolver and lower state. @internal */
// eslint-disable-next-line @typescript-eslint/require-await
export async function buildDocumentFromContext(
  context: DocumentContext,
  options: AsyncAPIEmitterOptions,
  artifacts: SchemaArtifactIndex = emptySchemaArtifacts,
): Promise<AsyncAPIDocument> {
  // One build owns one record of which binding applications it placed. It is
  // passed explicitly, so two builds of one program cannot see each other's.
  const placements = new BindingPlacements();
  const { program, service, declarations } = context;
  const doc = lowerDocument(
    program,
    resolveService(program, service, placements, artifacts, declarations),
    options,
  );
  if (context.version !== undefined) {
    const authored = service === undefined ? undefined : getInfo(program, service.type)?.version;
    if (authored !== undefined && authored !== context.version) {
      reportDiagnostic(program, {
        code: "version-info-conflict",
        target: context.root,
        format: { authored, version: context.version },
      });
    }
    doc.info.version = context.version;
  }
  return doc;
}
