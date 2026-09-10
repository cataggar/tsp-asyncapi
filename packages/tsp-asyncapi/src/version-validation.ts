import {
  isTemplateInstance,
  getNamespaceFullName,
  ListenerFlow,
  navigateType,
  type Model,
  type Type,
} from "@typespec/compiler";
import {
  $added,
  $madeOptional,
  $madeRequired,
  $removed,
  $renamedFrom,
  $typeChangedFrom,
  getVersions,
  findVersionedNamespace,
} from "@typespec/versioning";
import { getChannel, getHeadersModel, getRawPayload, reportDiagnostic } from "tsp-asyncapi-core";
import { discoverDocumentDeclarations, type DocumentContext } from "./document-context.js";

/**
 * A raw payload replaces the typed body, so its authored fields cannot follow
 * property evolution. Availability/renaming of the envelope itself is fine.
 * Static raw bodies and local pointers still use normal per-view validation.
 *
 * @internal
 */
export function validateVersionedInputs(context: DocumentContext): boolean {
  const selected = validateUnselectedVersions(context);
  if (context.realm === undefined) return selected;
  let valid = selected;
  for (const model of context.artifactInput.models) {
    if (!validateHeaders(context, model)) valid = false;
    if (getRawPayload(context.program, model) === undefined) continue;
    const source = context.sourceModels?.get(model) ?? model;
    const changes = new Set<Type>();
    const inspect = (type: Type) => {
      if (
        type !== source &&
        "decorators" in type &&
        type.decorators.some((application) =>
          [$added, $removed, $renamedFrom, $madeOptional, $madeRequired, $typeChangedFrom].some(
            (decorator) => decorator === application.decorator,
          ),
        )
      )
        changes.add(type);
    };
    navigateType(
      source,
      {
        namespace: () => ListenerFlow.NoRecursion,
        model: inspect,
        modelProperty: inspect,
        enum: inspect,
        enumMember: inspect,
        union: inspect,
        unionVariant: inspect,
        scalar: inspect,
      },
      {},
    );
    if (changes.size === 0) continue;
    reportDiagnostic(context.program, {
      code: "unsupported-versioned-contract",
      target: model,
      format: {
        version: context.version ?? "dependency-only",
        reason:
          "@rawPayload replaces a body with versioned fields; raw schemas are not transformed",
      },
    });
    valid = false;
  }

  function validateUnselectedVersions(context: DocumentContext): boolean {
    const unselected = new Set<Type>();
    const inspect = (type: Type) => {
      const [namespace, versions] = getVersions(context.program, type);
      if (namespace === undefined || versions === undefined) return;
      const owner = findVersionedNamespace(context.program, namespace) ?? namespace;
      if (
        context.realm?.hasType(type) !== true ||
        context.versionChoices?.has(getNamespaceFullName(owner)) !== true
      )
        unselected.add(type);
    };
    for (const model of context.artifactInput.models) {
      for (const root of [model, getHeadersModel(context.program, model)]) {
        if (root === undefined) continue;
        navigateType(
          root,
          {
            namespace: () => ListenerFlow.NoRecursion,
            model: inspect,
            scalar: inspect,
            enum: inspect,
            union: inspect,
          },
          {},
        );
      }
    }
    const declarations = context.declarations ?? discoverDocumentDeclarations(context.root);
    for (const channel of declarations.channels) {
      if (getChannel(context.program, channel) !== undefined) inspect(channel);
    }
    if (unselected.size === 0) return true;
    reportDiagnostic(context.program, {
      code: "unsupported-versioned-contract",
      target: [...unselected][0],
      format: {
        version: "unselected",
        reason:
          "versioned declarations have no root or dependency version selection; declare a versioned @service or @useDependency",
      },
    });
    return false;
  }
  return valid;
}

function validateHeaders(context: DocumentContext, message: Model): boolean {
  const headers = getHeadersModel(context.program, message);
  if (headers === undefined) return true;
  const unavailable = new Set<Model>();
  navigateType(
    headers,
    {
      namespace: () => ListenerFlow.NoRecursion,
      model(model) {
        if (model.name === "" || model.namespace === undefined) return;
        const declaration = model.namespace.models.get(model.name);
        if (declaration === model) return;
        if (isTemplateInstance(model) && declaration?.node === model.node) return;
        unavailable.add(model);
      },
    },
    {},
  );
  for (const model of unavailable) {
    reportDiagnostic(context.program, {
      code: "unsupported-versioned-contract",
      target: message,
      format: {
        version: context.version ?? "dependency-only",
        reason: `@headers refers to '${model.name}', which is not a live model in this view`,
      },
    });
  }
  return unavailable.size === 0;
}
