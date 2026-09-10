import { describe, expect, it } from "vitest";
import { emitDocument, emitDocumentWithDiagnostics } from "../utils/test-host.js";
import { targetText } from "../utils/diagnostics.js";
import { createMessageValidator } from "../utils/payload-validation.js";

const channel = '@channel("events") interface Events { @send op send(event: Event): void; }';
const date = "2026-09-10T00:00:00Z";

it.each([
  {
    declaration: "scalar Named extends utcDateTime;",
    scalar: "int32",
    encoding: "@encode(string)",
    warnings: 1,
    stringZero: true,
  },
  {
    declaration: "scalar Named extends int32;",
    scalar: "utcDateTime",
    encoding: '@encode("rfc3339")',
    warnings: 0,
    stringZero: false,
  },
])(
  "reads annotated references inside a named oneOf union: $declaration",
  async ({ declaration, scalar, encoding, warnings, stringZero }) => {
    const { doc, diagnostics } = await emitDocumentWithDiagnostics(`
    ${declaration}
    @oneOf union Choice {
      primary: ${scalar},
      @doc("A referenced branch with an allOf annotation wrapper.") secondary: Named,
      empty: null
    }
    @message model Event { @minValue(1) ${encoding} value: Choice; }
    ${channel}
  `);
    if (!doc) throw new Error("Expected emitted output");
    expect(diagnostics).toHaveLength(warnings);
    expect(
      diagnostics.every(
        (diagnostic) => diagnostic.code === "tsp-asyncapi/unsupported-encoded-constraint",
      ),
    ).toBe(true);
    expect(JSON.stringify(doc.components?.schemas)).toContain('"allOf"');
    expect(JSON.stringify(doc.components?.schemas).includes('"minimum":1')).toBe(warnings === 0);
    const validator = createMessageValidator(doc, "Event");
    expect(validator.validate({ payload: { value: 0 } }).accepted).toBe(false);
    expect(validator.validate({ payload: { value: "0" } }).accepted).toBe(stringZero);
    expect(validator.validate({ payload: { value: 1 } }).accepted).toBe(warnings === 0);
    expect(validator.validate({ payload: { value: null } }).accepted).toBe(true);
  },
);

for (const nullable of [false, true]) {
  const suffix = nullable ? " | null" : "";

  describe(`Encoded union references (${nullable ? "nullable" : "nonnullable"})`, () => {
    it.each([
      {
        name: "Date",
        declarations: "scalar Date extends utcDateTime;",
        sample: date,
      },
      {
        name: "Label",
        declarations: '@pattern("^label:") scalar Label extends string;',
        sample: "label:a",
      },
      {
        name: "Label",
        declarations: `
          @minLength(2) scalar Base extends string;
          @minLength(3) @pattern("^label:") scalar Label extends Base;
        `,
        sample: "label:a",
      },
    ])(
      "diagnoses numeric bounds lost beside referenced $name",
      async ({ name, declarations, sample }) => {
        const source = (encoding: string) => `
        ${declarations}
        @message model Event {
          @minValue(1) ${encoding} value: int32 | ${name}${suffix};
          plain?: ${name};
        }
        ${channel}
      `;
        const control = await emitDocument(source(""));
        const original = createMessageValidator(control, "Event");
        for (const value of [0, "0"]) {
          expect(original.validate({ payload: { value } }).accepted).toBe(false);
        }
        for (const value of [1, sample]) {
          expect(original.validate({ payload: { value } }).accepted).toBe(true);
        }
        const { doc, diagnostics } = await emitDocumentWithDiagnostics(source("@encode(string)"));
        if (!doc) throw new Error("Expected warned output");
        const validator = createMessageValidator(doc, "Event");
        expect(validator.validate({ payload: { value: "0" } }).accepted).toBe(true);
        expect(validator.validate({ payload: { value: 1 } }).accepted).toBe(false);
        expect(validator.validate({ payload: { value: sample, plain: sample } }).accepted).toBe(
          true,
        );
        expect(validator.validate({ payload: { value: "0", plain: "0" } }).accepted).toBe(false);
        expect(validator.validate({ payload: { value: null } }).accepted).toBe(nullable);
        expect(doc.components?.schemas?.[name]).toEqual(control.components?.schemas?.[name]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({
          code: "tsp-asyncapi/unsupported-encoded-constraint",
          severity: "warning",
        });
        expect(targetText(diagnostics[0])).toContain("value:");
        expect(diagnostics[0].message).toContain("minimum");
        expect(diagnostics[0].message).toContain("string");
        expect(JSON.stringify(doc.components?.schemas)).not.toContain('"minimum"');
      },
    );

    it.each([
      {
        declarations: "scalar Count extends int32;",
        union: "utcDateTime | Count",
        encoding: '@encode("rfc3339")',
        other: date,
        stringZero: false,
      },
      {
        declarations: `
          @encode("unixTimestamp", int32) scalar Epoch extends utcDateTime;
          scalar Count extends Epoch;
        `,
        union: "int32 | Count",
        encoding: "@encode(string)",
        other: "2",
        stringZero: true,
      },
    ])(
      "retains bounds governing a referenced numeric wire type: $declarations",
      async ({ declarations, union, encoding, other, stringZero }) => {
        const source = (encode: string) => `
        ${declarations}
        @message model Event {
          @minValue(1) ${encode} value: ${union}${suffix};
          plain?: Count;
        }
        ${channel}
      `;
        const control = await emitDocument(source(""));
        const doc = await emitDocument(source(encoding));
        expect(doc.components?.schemas?.Count).toEqual(control.components?.schemas?.Count);
        expect(JSON.stringify(doc.components?.schemas)).toContain('"minimum":1');
        const validator = createMessageValidator(doc, "Event");
        expect(validator.validate({ payload: { value: 0 } }).accepted).toBe(false);
        expect(validator.validate({ payload: { value: "0" } }).accepted).toBe(stringZero);
        expect(validator.validate({ payload: { value: 1, plain: 0 } }).accepted).toBe(true);
        expect(validator.validate({ payload: { value: 1, plain: "0" } }).accepted).toBe(false);
        expect(validator.validate({ payload: { value: other } }).accepted).toBe(true);
        expect(validator.validate({ payload: { value: null } }).accepted).toBe(nullable);
      },
    );

    it("uses an inherited string encoding rather than the referenced scalar's numeric source type", async () => {
      const { doc, diagnostics } = await emitDocumentWithDiagnostics(`
        @encode(string) scalar TextNumber extends int32;
        scalar Count extends TextNumber;
        @message model Event {
          @minValue(1) @encode("rfc3339") value: utcDateTime | Count${suffix};
          plain?: Count;
        }
        ${channel}
      `);
      if (!doc) throw new Error("Expected warned output");
      const validator = createMessageValidator(doc, "Event");
      expect(validator.validate({ payload: { value: "0", plain: "0" } }).accepted).toBe(true);
      expect(validator.validate({ payload: { value: 1 } }).accepted).toBe(false);
      expect(validator.validate({ payload: { value: date } }).accepted).toBe(true);
      expect(validator.validate({ payload: { value: null } }).accepted).toBe(nullable);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "tsp-asyncapi/unsupported-encoded-constraint",
        severity: "warning",
      });
      expect(targetText(diagnostics[0])).toContain("value:");
      expect(diagnostics[0].message).toContain("minimum");
      expect(JSON.stringify(doc.components?.schemas)).not.toContain('"minimum"');
    });
  });
}

it("keeps bounds when a referenced opaque scalar might still accept numbers", async () => {
  const { doc, diagnostics } = await emitDocumentWithDiagnostics(`
    scalar Opaque;
    @message model Event {
      @minValue(1) @encode(string) value: int32 | Opaque | null;
    }
    ${channel}
  `);
  if (!doc) throw new Error("Expected warned output");
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    code: "tsp-asyncapi/unmapped-schema-scalar",
    severity: "warning",
  });
  expect(JSON.stringify(doc.components?.schemas)).toContain('"minimum":1');
  const validator = createMessageValidator(doc, "Event");
  expect(validator.validate({ payload: { value: 0 } }).accepted).toBe(false);
  for (const value of [1, "0", null]) {
    expect(validator.validate({ payload: { value } }).accepted).toBe(true);
  }
});
