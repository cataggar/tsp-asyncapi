import { describe, expect, it } from "vitest";
import { retentionFixtures } from "../fixtures/contract-fidelity/retention.js";
import { readJson } from "../utils/evolution.js";
import { createMessageValidator } from "../utils/payload-validation.js";
import {
  emitRetentionVersions,
  expectRetentionShape,
  retentionDocument,
  retentionVersions,
} from "../utils/retained-messages.js";

describe("Version-generated JSON retained messages", () => {
  it("keeps the bounded matrix and its expected rejections explicit", () => {
    const witnesses = retentionFixtures.flatMap((row) => row.witnesses);
    const outcomes = witnesses.flatMap((witness) => [...witness.tolerant, ...witness.strict]);
    expect(retentionFixtures).toHaveLength(10);
    expect(witnesses).toHaveLength(34);
    expect(outcomes).toHaveLength(204);
    expect(outcomes.filter((accepted) => !accepted)).toHaveLength(70);
  });

  it.each(retentionFixtures)("$id", async (row) => {
    const documents = await emitRetentionVersions(row.source);
    const snapshots = retentionVersions.map((version) => retentionDocument(documents, version));
    snapshots.forEach((doc, index) => {
      expectRetentionShape(doc, row.shapes[index]);
    });
    expect(new Set(row.witnesses.map((value) => value.producer))).toEqual(
      new Set(retentionVersions),
    );

    const consumers = snapshots.map((doc, index) => ({
      tolerant: createMessageValidator(doc, "Event"),
      strict: createMessageValidator(
        doc,
        "Event",
        { knownFields: { "": Object.keys(row.shapes[index].payload.properties) } },
        { knownFields: { "": Object.keys(row.shapes[index].headers?.properties ?? {}) } },
      ),
    }));
    // Capture once with the producer's selected snapshot; never serialize against a consumer.
    const queue = row.witnesses.map((witness) => {
      const writer = retentionDocument(documents, witness.producer);
      const original = structuredClone(witness.message);
      const produced = readJson(writer, writer, witness.message);
      expect(produced.accepted).toBe(true);
      expect(produced.value).toEqual(original);
      expect(witness.message).toEqual(original);
      return { witness, produced, original };
    });

    for (const { witness, produced, original } of queue) {
      for (const [index, consumer] of consumers.entries()) {
        for (const policy of ["tolerant", "strict"] as const) {
          const result = consumer[policy].validate(produced.value);
          const context = `${row.id}: ${witness.name}: P${witness.producer}->C${retentionVersions[index]} ${policy}`;
          expect(result.accepted, `${context}: ${result.errors.join("; ")}`).toBe(
            witness[policy][index],
          );
          expect(result.errors.length === 0, context).toBe(result.accepted);
          expect(produced.value, context).toEqual(original);
          expect(JSON.parse(produced.wire), context).toEqual(original);
        }
      }
    }
  });

  it("keeps the same v1 record through independently selected v2 and v3 deployments", async () => {
    const row = retentionFixtures.find((fixture) => fixture.id.startsWith("R07 "));
    if (row === undefined) throw new Error("Missing constraint retention fixture.");
    const v1 = retentionDocument(await emitRetentionVersions(row.source, "1.0"), "1.0");
    expectRetentionShape(v1, row.shapes[0]);
    const retained = readJson(v1, v1, { payload: { id: "queued-at-v1", amount: 0 } });
    expect(retained.accepted).toBe(true);
    const originalWire = retained.wire;
    for (const [version, index, accepted] of [
      ["2.0", 1, false],
      ["3.0", 2, true],
    ] as const) {
      const consumer = retentionDocument(await emitRetentionVersions(row.source, version), version);
      expectRetentionShape(consumer, row.shapes[index]);
      const result = createMessageValidator(consumer, "Event").validate(retained.value);
      expect(result.accepted).toBe(accepted);
      if (!accepted) expect(result.errors).toEqual([expect.stringContaining("minimum")]);
      expect(retained.value).toEqual({ payload: { id: "queued-at-v1", amount: 0 } });
      expect(retained.wire).toBe(originalWire);
    }
  });

  it("refuses capture if the fixture is not admitted by its producer version", async () => {
    const row = retentionFixtures.find((fixture) => fixture.id.startsWith("R02 "));
    if (row === undefined) throw new Error("Missing required-addition retention fixture.");
    const v2 = retentionDocument(await emitRetentionVersions(row.source, "2.0"), "2.0");
    expectRetentionShape(v2, row.shapes[1]);
    expect(() => readJson(v2, v2, { payload: { id: "not-producer-valid" } })).toThrow(
      "writer-valid",
    );
  });
});
