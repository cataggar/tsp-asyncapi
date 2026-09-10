import {
  interpolatePath,
  resolvePath,
  type DiagnosticTarget,
  type Program,
} from "@typespec/compiler";
import { reportDiagnostic } from "tsp-asyncapi-core";

/** Stable identity inputs; version adapters supply values, not compiler-specific objects. @internal */
export interface DocumentOutputInput<T> {
  readonly document: T;
  readonly serviceName?: string;
  readonly multipleServices: boolean;
  readonly version?: string;
  readonly fileType: "yaml" | "json";
  readonly target: DiagnosticTarget;
}

/** A preflighted filename and resolved destination for one document. @internal */
export interface PlannedDocumentOutput<T> {
  readonly document: T;
  readonly filename: string;
  readonly path: string;
}

const DEFAULT_TEMPLATE = "asyncapi.{service-name-if-multiple}.{version}.{file-type}";
const TOKENS = new Set(["service-name", "service-name-if-multiple", "version", "file-type"]);

function trimPortableSegment(value: string): string {
  let end = value.length;
  while (end > 0 && /[. ]/.test(value[end - 1])) end--;
  return value.slice(0, end);
}

/** UTF-8 escapes keep tokens portable; lone UTF-16 surrogates retain their identity. */
function encodeToken(value: string): string {
  if (value.length === 0) return "%EMPTY";
  const encoder = new TextEncoder();
  const parts: string[] = [];
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) {
      parts.push(`%u${code.toString(16).toUpperCase()}`);
      continue;
    }
    for (const byte of encoder.encode(character)) {
      parts.push(
        /[a-zA-Z0-9_.-]/.test(String.fromCharCode(byte))
          ? String.fromCharCode(byte)
          : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
      );
    }
  }
  let encoded = parts.join("");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(encoded)) {
    encoded = `%${encoded.charCodeAt(0).toString(16).toUpperCase()}${encoded.slice(1)}`;
  }
  const trimmed = trimPortableSegment(encoded);
  return trimmed + "%2E".repeat(encoded.length - trimmed.length);
}

/** Builds the entire output set before any write. Undefined means diagnostics refused the plan. @internal */
export function planDocumentOutputs<T>(
  program: Program,
  outputDir: string,
  inputs: readonly DocumentOutputInput<T>[],
  outputFile?: string,
): readonly PlannedDocumentOutput<T>[] | undefined {
  const template = outputFile ?? DEFAULT_TEMPLATE;
  const unknown = [...template.matchAll(/\{([^{}]*)\}/g)]
    .map((match) => match[1])
    .filter((token) => !TOKENS.has(token));
  const remaining = template.replace(/\{[^{}]*\}/g, "");
  if (unknown.length > 0 || /[{}]/.test(remaining)) {
    reportDiagnostic(program, {
      code: "invalid-output-file",
      target: inputs[0]?.target ?? program.getGlobalNamespaceType(),
      format: { filename: template, reason: `use only ${[...TOKENS].join(", ")} template tokens` },
    });
    return undefined;
  }
  const planned: PlannedDocumentOutput<T>[] = [];
  const paths = new Set<string>();
  let refused = false;
  for (const input of inputs) {
    const serviceName =
      input.serviceName === undefined ? undefined : encodeToken(input.serviceName);
    const filename = interpolatePath(template, {
      "service-name": serviceName,
      "service-name-if-multiple": input.multipleServices ? serviceName : undefined,
      version: input.version === undefined ? undefined : encodeToken(input.version),
      "file-type": input.fileType,
    });
    const normalized = filename.replaceAll("\\", "/");
    const basename = normalized.split("/").at(-1) ?? "";
    if (basename.length === 0 || /^[. ]+$/.test(basename)) {
      reportDiagnostic(program, {
        code: "invalid-output-file",
        target: input.target,
        format: { filename, reason: "the template must resolve to a filename, not a directory" },
      });
      refused = true;
      continue;
    }
    const path = resolvePath(outputDir, normalized);
    const key = path
      .replaceAll("\\", "/")
      .split("/")
      .map((segment) => trimPortableSegment(segment).toLowerCase())
      .join("/");
    if (paths.has(key)) {
      reportDiagnostic(program, {
        code: "duplicate-output-file",
        target: input.target,
        format: { filename },
      });
      refused = true;
    }
    paths.add(key);
    planned.push({ document: input.document, filename, path });
  }
  return refused ? undefined : planned;
}
