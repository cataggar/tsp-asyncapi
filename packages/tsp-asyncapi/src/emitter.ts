import { EmitContext, emitFile, getNamespaceFullName, listServices } from "@typespec/compiler";
import { reportDiagnostic } from "tsp-asyncapi-core";
import type { AsyncAPIEmitterOptions } from "./emitter-options.js";
import { buildDocumentFromContext } from "./pipeline.js";
import { createServiceDocumentContext, validateServiceOwnership } from "./service-context.js";
import { planDocumentOutputs } from "./document-output.js";
import { reportUnavailablePreviewFeatures } from "./preview-features.js";
import {
  availableFeatures,
  collectSchemaArtifacts,
  shippedProviders,
} from "./schema-artifacts/provider.js";
import yaml from "yaml";

/**
 * The compiler's entry point into this emitter.
 * It runs automatically when a project specifies `--emit tsp-asyncapi`.
 *
 * @param context - Context containing the program and emitter options.
 * @public
 */
export async function $onEmit(context: EmitContext<AsyncAPIEmitterOptions>) {
  const options = context.options;
  const program = context.program;
  const diagnosticStart = program.diagnostics.length;
  const hasPlanningError = () =>
    program.diagnostics.slice(diagnosticStart).some(({ severity }) => severity === "error");

  const providers = shippedProviders();

  const services = listServices(program);
  const selected =
    options.service === undefined
      ? services
      : services.filter((service) => getNamespaceFullName(service.type) === options.service);
  if (options.service !== undefined && selected.length === 0) {
    reportDiagnostic(program, {
      code: "unknown-service",
      target: program.getGlobalNamespaceType(),
      format: {
        name: options.service,
        available:
          services.map((service) => getNamespaceFullName(service.type)).join(", ") || "(none)",
      },
    });
  }
  if (options.service !== undefined && selected.length > 1) {
    reportDiagnostic(program, {
      code: "ambiguous-service-selection",
      target: program.getGlobalNamespaceType(),
      format: { name: options.service },
    });
  }
  validateServiceOwnership(program, services);
  const unavailable = reportUnavailablePreviewFeatures(
    program,
    options,
    availableFeatures(providers),
  );
  if (unavailable || hasPlanningError()) return;
  const contexts = (services.length === 0 ? [undefined] : selected).map((service) =>
    createServiceDocumentContext(program, service, services),
  );
  const fileType = options["file-type"] ?? "yaml";
  const outputs = planDocumentOutputs(
    program,
    context.emitterOutputDir,
    contexts.map((document) => ({
      document,
      serviceName: document.originalServiceId,
      multipleServices: services.length > 1,
      fileType,
      target: document.service?.type ?? program.getGlobalNamespaceType(),
    })),
    options["output-file"],
  );
  if (outputs === undefined || hasPlanningError()) return;
  const pending: { path: string; content: string }[] = [];
  let refused = false;
  for (const output of outputs) {
    const collected = await collectSchemaArtifacts(
      program,
      new Set(options["preview-features"] ?? []),
      providers,
      output.document.artifactInput,
    );
    refused ||= collected.refused;
    const doc = await buildDocumentFromContext(output.document, options, collected.artifacts);
    pending.push({
      path: output.path,
      content:
        fileType === "json" ? JSON.stringify(doc, null, 2) : yaml.stringify(doc, { lineWidth: 0 }),
    });
  }
  // Resolve/lower every selected document before the first write, including noEmit.
  // Existing diagnostic-and-drop recovery remains intact; shared security ambiguity is a new refusal.
  const ambiguousSecurity = program.diagnostics
    .slice(diagnosticStart)
    .some(({ code }) => code === "tsp-asyncapi/ambiguous-security-scheme");
  if (refused || ambiguousSecurity || program.compilerOptions.noEmit) return;
  for (const output of pending) await emitFile(program, output);
}
