import { describe, expect, it } from "vitest";
import { emitDocument } from "../utils/test-host.js";
import { readJson } from "../utils/evolution.js";
import { releases } from "../fixtures/contract-fidelity/evolution.js";

const channel = '@channel("events") interface Events { @send op send(event: Event): void; }';

describe("JSON evolution: independently compiled producer and consumer", () => {
  it.each(releases)("$id runs both same-version and both cross-version controls", async (row) => {
    // Separate compilations, even where a release reuses declaration names.
    const old = await emitDocument(`${row.old} ${channel}`);
    const next = await emitDocument(`${row.next} ${channel}`);
    for (const [writer, reader, values] of [
      [old, next, row.oldValues],
      [next, old, row.nextValues],
    ] as const) {
      for (const [value, crossAccepted] of values) {
        const original = structuredClone(value);
        expect(readJson(writer, writer, value).accepted).toBe(true);
        const read = readJson(writer, reader, value);
        expect(read.accepted, `${row.id}: ${read.wire}: ${read.errors.join("; ")}`).toBe(
          crossAccepted,
        );
        expect(read.value).toEqual(value);
        expect(value).toEqual(original);
      }
    }
  });

  it("E01 old open producer extra-field collision disproves universal optional-addition safety", async () => {
    const old = await emitDocument(`@message model Event { id: string; } ${channel}`);
    const next = await emitDocument(
      `@message model Event { id: string; note?: string; } ${channel}`,
    );
    const value = { payload: { id: "a", note: 42 } };
    expect(readJson(old, old, value).accepted).toBe(true);
    const read = readJson(old, next, value);
    expect(read.accepted).toBe(false);
    expect(read.errors).toEqual([expect.stringContaining("type")]);
    const declared = { payload: { id: "a", note: "text" } };
    expect(readJson(next, old, declared).accepted).toBe(true);
    expect(readJson(next, old, declared, { knownFields: { "": ["id"] } }).accepted).toBe(false);
  });

  it("E05 closed consumers explicitly govern inherited and nested object fields", async () => {
    const old = await emitDocument(`model Base { id: string; }
      @message model Event extends Base { child: { id: string; }; } ${channel}`);
    const next = await emitDocument(`model Base { id: string; }
      @message model Event extends Base { child: { id: string; note?: string; }; note?: string; } ${channel}`);
    const value = { payload: { id: "a", child: { id: "b", note: "nested" }, note: "top" } };
    expect(readJson(next, old, value).accepted).toBe(true);
    const closed = readJson(next, old, value, {
      knownFields: { "": ["id", "child"], "/child": ["id"] },
    });
    expect(closed.accepted).toBe(false);
    expect(closed.errors).toHaveLength(2);
    expect(
      readJson(
        old,
        old,
        { payload: { id: "a", child: { id: "b" } } },
        { knownFields: { "": ["id", "child"], "/child": ["id"] } },
      ).accepted,
    ).toBe(true);
  });

  it("rejects an invalid writer instead of calling consumer failure compatibility evidence", async () => {
    const doc = await emitDocument(`@message model Event { id: string; } ${channel}`);
    expect(() => readJson(doc, doc, { payload: { id: 1 } })).toThrow("writer-valid");
  });

  it("E10 closed header policy applies even before a release declares headers", async () => {
    const old = await emitDocument(`@message model Event { id: string; } ${channel}`);
    const next = await emitDocument(
      `@message model Event { @header trace?: string; id: string; } ${channel}`,
    );
    const value = { payload: { id: "a" }, headers: { trace: "t" } };
    expect(readJson(next, old, value).accepted).toBe(true);
    const closed = readJson(next, old, value, {}, { knownFields: { "": [] } });
    expect(closed.accepted).toBe(false);
    expect(closed.errors).toEqual([expect.stringContaining("headers/trace")]);
  });
});
