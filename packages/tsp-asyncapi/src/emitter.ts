import {
  EmitContext,
  emitFile,
  getNamespaceFullName,
  listServices,
  type Program,
  type Service,
} from "@typespec/compiler";
import { reportDiagnostic } from "tsp-asyncapi-core";
import type { AsyncAPIEmitterOptions } from "./emitter-options.js";
import { buildDocumentFromContext } from "./pipeline.js";
import { createServiceDocumentContext, validateServiceOwnership } from "./service-context.js";
import { planDocumentOutputs } from "./document-output.js";
import type { DocumentContext } from "./document-context.js";
import { planVersionedDocuments } from "./versioning.js";
import { validateVersionedInputs } from "./version-validation.js";
import { reportUnavailablePreviewFeatures } from "./preview-features.js";
import {
  availableFeatures,
  collectSchemaArtifacts,
  shippedProviders,
  type SchemaArtifactProvider,
} from "./schema-artifacts/provider.js";
import yaml from "yaml";

/** The compiler entry point. Plans every selected document before any write. @public */
export async function $onEmit(context: EmitContext<AsyncAPIEmitterOptions>) {
  const { program, options } = context;
  const diagnosticStart = program.diagnostics.length;
  const hasPlanningError = () =>
    program.diagnostics.slice(diagnosticStart).some(({ severity }) => severity === "error");
  const services = listServices(program);
  const selected = selectServices(program, services, options.service);
  validateServiceOwnership(program, services);
  const providers = shippedProviders();
  const unavailable = reportUnavailablePreviewFeatures(
    program,
    options,
    availableFeatures(providers),
  );
  if (selected === undefined || unavailable || hasPlanningError()) return;

  const versions = planVersionedDocuments(program, selected, options.version);
  if (versions === undefined || hasPlanningError()) return;
  const contexts: DocumentContext[] = [];
  for (const version of versions) {
    const document = createServiceDocumentContext(
      program,
      version.originalService,
      services,
      version.effective,
    );
    if (document === undefined) return;
    contexts.push(document);
  }
  const outputs = planDocumentOutputs(
    program,
    context.emitterOutputDir,
    contexts.map((document) => ({
      document,
      serviceName: document.originalServiceId,
      multipleServices: services.length > 1,
      version: document.version,
      fileType: options["file-type"] ?? "yaml",
      target: document.originalService?.type ?? program.getGlobalNamespaceType(),
    })),
    options["output-file"],
  );
  if (outputs === undefined || hasPlanningError()) return;
  const pending: { path: string; content: string }[] = [];
  let refused = false;
  for (const output of outputs) {
    const built = await buildOutput(output.document, options, providers);
    if (built.refused) {
      refused = true;
      continue;
    }
    pending.push({ path: output.path, content: built.content });
  }
  const ambiguousSecurity = program.diagnostics
    .slice(diagnosticStart)
    .some(({ code }) => code === "tsp-asyncapi/ambiguous-security-scheme");
  // Lowering omits malformed extensions; emitting that reduced contract would
  // conceal the failed authored constraint, even in a later selected service.
  const invalidSchemaExtension = program.diagnostics.some(
    ({ code }) => code === "tsp-asyncapi/invalid-schema-extension",
  );
  if (refused || ambiguousSecurity || invalidSchemaExtension || program.compilerOptions.noEmit)
    return;
  for (const output of pending) await emitFile(program, output);
}

function selectServices(
  program: Program,
  services: readonly Service[],
  selector?: string,
): readonly (Service | undefined)[] | undefined {
  if (selector === undefined) return services.length === 0 ? [undefined] : services;
  const selected = services.filter((service) => getNamespaceFullName(service.type) === selector);
  if (selected.length === 1) return selected;
  if (selected.length === 0) {
    reportDiagnostic(program, {
      code: "unknown-service",
      target: program.getGlobalNamespaceType(),
      format: {
        name: selector,
        available:
          services.map((service) => getNamespaceFullName(service.type)).join(", ") || "(none)",
      },
    });
  } else {
    reportDiagnostic(program, {
      code: "ambiguous-service-selection",
      target: program.getGlobalNamespaceType(),
      format: { name: selector },
    });
  }
  return undefined;
}

async function buildOutput(
  document: DocumentContext,
  options: AsyncAPIEmitterOptions,
  providers: readonly SchemaArtifactProvider[],
): Promise<{ refused: true } | { refused: false; content: string }> {
  const { program } = document;
  const validInputs = validateVersionedInputs(document);
  const diagnosticStart = program.diagnostics.length;
  const collected = await collectSchemaArtifacts(
    program,
    new Set(options["preview-features"] ?? []),
    providers,
    document.artifactInput,
  );
  if (collected.refused) return { refused: true };
  const doc = await buildDocumentFromContext(document, options, collected.artifacts);
  const invalidView =
    document.realm !== undefined &&
    program.diagnostics.slice(diagnosticStart).some(({ severity }) => severity === "error");
  if (invalidView) {
    reportDiagnostic(program, {
      code: "unsupported-versioned-contract",
      target: document.root,
      format: {
        version: document.version ?? "dependency-only",
        reason: "the selected view has invalid messaging or schema declarations (see diagnostics)",
      },
    });
  }
  if (!validInputs || invalidView) return { refused: true };
  return {
    content:
      options["file-type"] === "json"
        ? JSON.stringify(doc, null, 2)
        : yaml.stringify(doc, { lineWidth: 0 }),
    refused: false,
  };
}
