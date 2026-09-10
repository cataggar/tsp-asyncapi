import type { AsyncAPIDocument } from "#emitter/types/index.js";
import { createMessageValidator, type ConsumerProfile } from "./payload-validation.js";

export interface JsonMessage {
  readonly payload: unknown;
  readonly headers?: unknown;
}

/** Historic values are serialized with their own document before the reader sees them. */
export function readJson(
  writer: AsyncAPIDocument,
  reader: AsyncAPIDocument,
  value: JsonMessage,
  profile: ConsumerProfile = {},
  headerProfile: ConsumerProfile = {},
) {
  const validWriter = createMessageValidator(writer, "Event").validate(value);
  if (!validWriter.accepted) {
    throw new Error(`Fixture is not writer-valid: ${validWriter.errors.join("; ")}`);
  }
  const wire: string = JSON.stringify(value);
  const decoded = JSON.parse(wire) as JsonMessage;
  const outcome = createMessageValidator(reader, "Event", profile, headerProfile).validate(decoded);
  return { ...outcome, wire, value: decoded };
}
