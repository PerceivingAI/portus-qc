import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultInspectionCapability,
  parseCreateInspectionInput,
  parseInspection,
  toInspectionDefinition
} from "../config/inspection.ts";

test("app inspection config defaults existing-style creates to Query", () => {
  const inspection = parseCreateInspectionInput({
    id: "dented-cans",
    name: "Dented cans",
    prompt: "Look for visible dents on cans."
  });

  assert.deepEqual(inspection, {
    id: "dented-cans",
    name: "Dented cans",
    prompt: "Look for visible dents on cans.",
    enabled: true,
    capability: defaultInspectionCapability
  });
});

test("app inspection config accepts one capability and rejects decision-era shapes", () => {
  const base = {
    id: "blemished-apples",
    name: "Blemished apples",
    prompt: "Find visible blemishes on apples.",
    enabled: true,
    capability: "segment"
  };
  assert.equal(parseInspection(base).capability, "segment");
  assert.throws(() => parseInspection({ ...base, capability: "classify" }), /capability/u);
  assert.throws(() => parseInspection({ ...base, decisionMapping: { pass: "PASS" } }), /unsupported field/u);
  assert.throws(() => parseInspection({ ...base, output: { schema: "qc-v1" } }), /unsupported field/u);
  assert.throws(() => parseInspection({ ...base, tenantId: "not-allowed" }), /unsupported field/u);
});

test("app inspection converts to the reusable single-capability definition only at the execution boundary", () => {
  const inspection = parseCreateInspectionInput({ id: "labels", name: "Labels", prompt: "Check label placement.", capability: "point" });
  const definition = toInspectionDefinition(inspection);
  assert.deepEqual(definition, {
    id: "labels",
    name: "Labels",
    prompt: "Check label placement.",
    capability: "point"
  });
  assert.equal("enabled" in definition, false);
});
