import assert from "node:assert/strict";
import test from "node:test";
import { createQaEngine, prepareInferenceImage } from "../src/index.ts";
import { DeterministicVisionProvider, DeterministicVisualClassifier, referenceVisibilityPlugin } from "../src/reference.ts";

function image() {
  return prepareInferenceImage({
    id: "reference-frame",
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "image/jpeg",
    width: 640,
    height: 480,
    orientationNormalized: true,
    source: { sourceId: "fixture-camera", receivedAt: "2026-08-27T18:00:00Z" }
  });
}

function engine(answer = "yes") {
  let sequence = 0;
  return createQaEngine({
    vision: new DeterministicVisionProvider({ answer }),
    classifier: new DeterministicVisualClassifier(),
    now: () => "2026-08-27T18:00:01Z",
    idFactory: (kind) => `${kind}-fixture-${++sequence}`
  });
}

test("public engine facade runs the non-proprietary reference plugin offline", async () => {
  const result = await engine().screen({ plugin: referenceVisibilityPlugin, image: image() });
  assert.equal(result.id, "screening-result-fixture-1");
  assert.equal(result.profileId, "reference-subject-visibility");
  assert.equal(result.decision, "PASS");
  assert.equal(result.metrics.subject_visible, true);
  assert.equal(result.providerCalls.length, 1);
  assert.equal(result.providerCalls[0]?.provider, "deterministic-reference");
  for (const field of ["organizationId", "jobId", "traceId", "artifactRefs", "cameraId"]) assert.equal(field in result, false);
});

test("reference plugin reviews a deterministic negative visibility answer", async () => {
  const result = await engine("no").screen({ plugin: referenceVisibilityPlugin, image: image(), resultId: "screen-negative", createdAt: "2026-08-27T18:00:02Z" });
  assert.equal(result.id, "screen-negative");
  assert.equal(result.decision, "REVIEW");
  assert.equal(result.metrics.subject_visible, false);
});

test("calibration continues after an invalid classifier label and fails closed without losing later checks", async () => {
  const states = ["warning", "not-allowed", "fix-required", "ok", "ok"];
  let calls = 0;
  const classifier = {
    id: "fixture-classifier",
    model: "fixture-v1",
    async classify(request) {
      const label = states[calls++];
      return { label, provider: "fixture-classifier", model: "fixture-v1", requestId: `classify-${calls}` };
    }
  };
  const qa = createQaEngine({
    vision: new DeterministicVisionProvider(),
    classifier,
    now: () => "2026-08-27T18:00:01Z",
    idFactory: () => "calibration-run-fixture"
  });
  const result = await qa.calibrate({ image: image() });
  assert.equal(calls, 5);
  assert.equal(result.assessment, "needs-adjustment");
  assert.deepEqual(result.checks.map((check) => check.state), ["warning", "unknown", "fix-required", "ok", "ok"]);
  assert.equal(result.providerCalls.length, 5);
  assert.equal(result.providerCalls[1].status, "failed");
  assert.equal(result.providerCalls[1].errorCode, "invalid_label");
  assert.match(result.checks[0].message, /lighting/i);
  assert.match(result.checks[1].message, /obstruction/i);
});

test("public engine facade runs universal calibration offline", async () => {
  const result = await engine().calibrate({ image: image(), runId: "cal-reference", createdAt: "2026-08-27T18:00:03Z" });
  assert.equal(result.runId, "cal-reference");
  assert.equal(result.planId, "universal-image-quality");
  assert.equal(result.assessment, "suitable");
  assert.equal(result.checks.length, 5);
  assert.ok(result.checks.every((check) => check.state === "ok"));
  assert.equal(result.providerCalls.length, 5);
  assert.ok(result.providerCalls.every((call) => call.capability === "classify"));
  assert.ok(result.checks.every((check) => !check.message.includes("Deterministic fixture")));
});
