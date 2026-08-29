import assert from "node:assert/strict";
import test from "node:test";
import { prepareInferenceImage } from "../../media/src/index.ts";
import {
  compileInspectionDefinition,
  executeInspectionDefinition,
  InspectionConfigError,
  validateInspectionDefinition
} from "../src/index.ts";

const definition = {
  id: "dented-cans",
  name: "Dented cans",
  prompt: "Look for visible dents on cans.",
  capability: "detect"
};

function image() {
  return prepareInferenceImage({
    id: "fixture",
    bytes: new Uint8Array([1]),
    mimeType: "image/jpeg",
    width: 1,
    height: 1,
    orientationNormalized: true,
    source: { receivedAt: "2026-08-27T00:00:00.000Z" }
  });
}

test("inspection definitions preserve one prompt and one selected capability", () => {
  const normalized = validateInspectionDefinition({ ...definition, name: "  Dented cans  " });
  assert.deepEqual(normalized, definition);

  const compiled = compileInspectionDefinition(normalized);
  assert.deepEqual(compiled, definition);
  assert.equal(Object.isFrozen(compiled), true);
});

test("all launch capabilities are accepted", () => {
  for (const capability of ["query", "detect", "segment", "point", "caption"]) {
    assert.equal(validateInspectionDefinition({ ...definition, capability }).capability, capability);
  }
});

test("inspection execution makes exactly one selected-capability provider call", async () => {
  let calls = 0;
  let request;
  const provider = {
    id: "fixture-provider",
    model: "fixture-v1",
    supports: () => true,
    execute: async (value) => {
      calls += 1;
      request = value;
      return {
        capability: "detect",
        result: { capability: "detect", boxes: [{ xMin: 0.1, yMin: 0.2, xMax: 0.3, yMax: 0.4 }] },
        provider: "fixture-provider",
        model: "fixture-v1"
      };
    }
  };

  const response = await executeInspectionDefinition(definition, image(), provider);
  assert.equal(calls, 1);
  assert.equal(request.capability, "detect");
  assert.equal(request.prompt, definition.prompt);
  assert.deepEqual(response.result.boxes, [{ xMin: 0.1, yMin: 0.2, xMax: 0.3, yMax: 0.4 }]);
});

test("inspection execution rejects unsupported or mismatched provider capability", async () => {
  await assert.rejects(
    () => executeInspectionDefinition(definition, image(), { id: "no-detect", model: "fixture", supports: () => false, execute: async () => { throw new Error("must not call"); } }),
    (error) => error instanceof InspectionConfigError && /does not support/u.test(error.message)
  );

  await assert.rejects(
    () => executeInspectionDefinition(definition, image(), {
      id: "mismatch",
      model: "fixture",
      supports: () => true,
      execute: async () => ({ capability: "query", result: { capability: "query", text: "wrong capability" }, provider: "mismatch", model: "fixture" })
    }),
    (error) => error instanceof InspectionConfigError && /returned query/u.test(error.message)
  );
});

test("inspection definitions reject decision-era and multi-capability shapes", () => {
  assert.throws(() => validateInspectionDefinition({ ...definition, id: "bad id" }), /Inspection id/u);
  assert.throws(() => validateInspectionDefinition({ ...definition, capability: "classify" }), /capability/u);
  assert.throws(() => validateInspectionDefinition({ ...definition, enabled: true }), /unsupported field/u);
  assert.throws(() => validateInspectionDefinition({ ...definition, output: { schema: "qc-v1" } }), /unsupported field/u);
  assert.throws(() => validateInspectionDefinition({ ...definition, capabilities: ["detect", "segment"] }), /unsupported field/u);
  assert.throws(() => validateInspectionDefinition(null), /must be an object/u);
});
