import { expect } from "vitest";
import { expectDiagnosticEmpty } from "@typespec/compiler/testing";
import { isPlainObject } from "tsp-asyncapi-core";
import type { AsyncAPIDocument, SchemaObject } from "#emitter/types/index.js";
import { emitVersioned, VersioningTester } from "./versioning.js";
import { emitDocumentsWithDiagnostics } from "./test-host.js";
import { emittedSchema } from "./payload-validation.js";

export const retentionVersions = ["1.0", "2.0", "3.0"] as const;
export type RetentionVersion = (typeof retentionVersions)[number];
export type ThreeVersions<T> = readonly [T, T, T];

interface ObjectShape {
  readonly properties: Readonly<Record<string, SchemaObject>>;
  readonly required: readonly string[];
}

export interface MessageShape {
  readonly payload: ObjectShape;
  readonly headers?: ObjectShape;
}

export function retentionSource(fields: string, declarations = ""): string {
  return `
    @service @versioned(Versions) namespace App {
      enum Versions { v1: "1.0", v2: "2.0", v3: "3.0" }
      ${declarations}
      @message model Event { id: string; ${fields} }
      @channel("events") interface Events { @send op publish(event: Event): void; }
    }
  `;
}

export async function emitRetentionVersions(
  source: string,
  version?: RetentionVersion,
  provider?: "avro" | "protobuf",
  nativeCompanion = false,
) {
  const options = {
    "file-type": "json",
    ...(version === undefined ? {} : { version }),
    ...(provider === undefined || nativeCompanion ? {} : { "preview-features": [provider] }),
  };
  const library = provider === "avro" ? "tsp-avro" : "@typespec/protobuf";
  const result =
    provider === undefined
      ? await emitVersioned(source, options)
      : await emitDocumentsWithDiagnostics(
          source,
          options,
          false,
          VersioningTester.import(library),
        );
  expectDiagnosticEmpty(result.diagnostics);
  const selected = version === undefined ? retentionVersions : [version];
  const filenames = selected.map((item) => `asyncapi.${item}.json`);
  expect(Object.keys(result.outputs)).toEqual(filenames);
  expect(Object.keys(result.documents)).toEqual(filenames);
  for (const item of selected) {
    const doc = retentionDocument(result.documents, item);
    expect(doc.asyncapi).toBe("3.1.0");
    expect(doc.info.version).toBe(item);
    expect(Object.keys(doc.components?.messages ?? {})).toEqual(["Event"]);
    expect(Object.keys(doc.channels ?? {})).toEqual(["events"]);
    expect(doc.channels?.events.address).toBe("events");
    expect(doc.operations?.publish).toMatchObject({ action: "send" });
  }
  return result.documents;
}

export function retentionDocument(
  documents: Readonly<Record<string, AsyncAPIDocument>>,
  version: RetentionVersion,
): AsyncAPIDocument {
  const filename = `asyncapi.${version}.json`;
  if (!Object.hasOwn(documents, filename)) {
    throw new Error(`Missing retained-message snapshot ${version}.`);
  }
  return documents[filename];
}

function expectObjectShape(doc: AsyncAPIDocument, value: unknown, expected: ObjectShape): void {
  const schema = emittedSchema(doc, value);
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) {
    throw new Error("Expected an emitted object schema with properties.");
  }
  expect(schema.type).toBe("object");
  expect(Object.keys(schema.properties)).toEqual(Object.keys(expected.properties));
  expect(schema.required ?? []).toEqual(expected.required);
  for (const [name, property] of Object.entries(expected.properties)) {
    expect(emittedSchema(doc, schema.properties[name]), name).toEqual(property);
  }
}

export function expectRetentionShape(doc: AsyncAPIDocument, expected: MessageShape): void {
  const message = doc.components?.messages?.Event;
  expectObjectShape(doc, message?.payload, expected.payload);
  if (expected.headers === undefined) {
    expect(message?.headers).toBeUndefined();
  } else {
    expectObjectShape(doc, message?.headers, expected.headers);
  }
}
