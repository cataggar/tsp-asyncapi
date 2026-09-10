import type { Model, Namespace, Operation, Program, Type } from "@typespec/compiler";
import {
  getChannelInternal,
  listChannelsInternal,
  type ChannelTarget,
} from "../decorators/channels/state.js";
import { getActionInternal, listOperationActions } from "../decorators/operations/state.js";
import {
  getMessageState,
  listMessages,
  type MessageState,
} from "../decorators/messages/message.js";
import { bySourcePosition, sourcePositionOf } from "../source-order.js";

/**
 * The live declarations selected for one document, before assigning keys.
 *
 * This is an identity boundary, not a service ownership policy. Callers may
 * supply a transformed graph on the original Program. Excluded declarations
 * must not return through program-wide state lists or reverse reply indexes.
 * Omitting this input preserves the legacy whole-program discovery path.
 *
 * @internal
 */
export interface DocumentDeclarations {
  /** Candidate models, including reachable template instances; only markers become messages. */
  readonly models: readonly Model[];
  /** Candidate channel declarations; direct channel ownership is unchanged. */
  readonly channels: readonly ChannelTarget[];
  /** Includes unmarked operations that can still contribute channel messages and parameters. */
  readonly operations: readonly Operation[];
  /** Namespaces whose security scheme declarations are visible to this document. */
  readonly namespaces: readonly Namespace[];
  /** Optional per-namespace name selection, for explicitly used shared schemes. */
  readonly securitySchemes?: ReadonlyMap<Namespace, ReadonlySet<string>>;
  /** Includes misplaced declarations whose diagnostics belong to this document. */
  readonly diagnosticTargets: ReadonlySet<Type>;
}

/** Reads message state for the selected live identities, in source order. */
export function documentMessages(
  program: Program,
  declarations?: DocumentDeclarations,
): ReadonlyMap<Model, MessageState> {
  if (declarations === undefined) return listMessages(program);
  const entries: [Model, MessageState][] = [];
  for (const model of declarations.models) {
    const state = getMessageState(program, model);
    if (state !== undefined) entries.push([model, state]);
  }
  const compare = bySourcePosition(program);
  entries.sort(([a], [b]) => compare(sourcePositionOf(a), sourcePositionOf(b)));
  return new Map(entries);
}

/** Reads channels without reintroducing excluded state-map keys. */
export function documentChannels(program: Program, declarations?: DocumentDeclarations) {
  if (declarations === undefined) return listChannelsInternal(program);
  const compare = bySourcePosition(program);
  return declarations.channels
    .flatMap((target) => {
      const record = getChannelInternal(program, target);
      return record === undefined ? [] : [{ target, record }];
    })
    .sort((a, b) => compare(a.record, b.record));
}

/** Reads actions on live operations, retaining the established source order. */
export function documentActions(program: Program, declarations?: DocumentDeclarations) {
  if (declarations === undefined) return listOperationActions(program);
  const compare = bySourcePosition(program);
  return declarations.operations
    .flatMap((target) => {
      const entry = getActionInternal(program, target);
      return entry === undefined ? [] : [{ target, entry }];
    })
    .sort((a, b) => compare(a.entry, b.entry))
    .map(({ target, entry }) => ({ target, record: entry.record }));
}
