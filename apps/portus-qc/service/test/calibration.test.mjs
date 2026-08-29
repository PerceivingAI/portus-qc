import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import sharp from "sharp";
import { prepareInferenceImage } from "@portus-qc/engine";
import { createCalibrationService } from "../src/domain/calibration.ts";
import { createPortusQcHttpServer } from "../src/server.ts";

function image() {
  return prepareInferenceImage({
    id: "visible-input-frame",
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "image/jpeg",
    width: 640,
    height: 480,
    orientationNormalized: true,
    source: { sourceId: "visible-input", receivedAt: "2026-08-28T12:00:00.000Z" }
  });
}

const answer = JSON.stringify({
  lighting: { state: "ok", note: "Lighting is even enough for useful visual detail." },
  obstruction: { state: "warning", note: "A small foreground object partially covers the lower-left scene." },
  focus: { state: "ok", note: "Visible scene detail is in usable focus." },
  glare: { state: "fix-required", note: "Reduce the strong reflection near the center of the frame." },
  framing: { state: "ok", note: "The scene has generally usable coverage." }
});

test("input calibration report evaluates the supplied visible image with one hidden native Moondream Query", async () => {
  const requests = [];
  const rawResponses = [];
  const visibleImage = image();
  const service = createCalibrationService({
    runtime: {
      createMoondream: async () => ({
        id: "moondream",
        model: "fixture-v1",
        supports: () => true,
        async execute(request) {
          requests.push(request);
          return {
            capability: "query",
            result: { capability: "query", text: answer },
            provider: "moondream",
            model: "fixture-v1",
            requestId: "query-1",
            durationMs: 12
          };
        }
      })
    },
    now: () => "2026-08-28T12:00:01.000Z",
    idFactory: () => "cal-run",
    onRawResponse: (observation) => rawResponses.push(observation)
  });

  const result = await service.calibrate(visibleImage);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].image, visibleImage, "calibration must evaluate the supplied visible Input image rather than capture another source");
  assert.equal(requests[0].capability, "query");
  assert.match(requests[0].prompt, /lighting, obstruction, focus, glare, framing/u);
  assert.match(requests[0].prompt, /informational input calibration report/u);
  assert.deepEqual(rawResponses, [{ provider: "moondream", model: "fixture-v1", requestId: "query-1", text: answer }],
    "the exact raw Moondream answer must be observable before calibration parsing without being persisted as a report");
  assert.equal(result.planId, "input-moondream-readiness");
  assert.equal(result.planVersion, 2);
  assert.equal(result.assessment, "needs-adjustment");
  assert.deepEqual(result.checks.map((check) => [check.id, check.state]), [
    ["lighting", "ok"],
    ["obstruction", "warning"],
    ["focus", "ok"],
    ["glare", "fix-required"],
    ["framing", "ok"]
  ]);
  assert.equal(result.providerCalls.length, 1);
  assert.equal(result.providerCalls[0].capability, "query");
});

test("input calibration accepts Moondream shorthand state JSON and supplies deterministic messages", async () => {
  const shorthandAnswer = JSON.stringify({
    lighting: "ok",
    obstruction: "ok",
    focus: "ok",
    glare: "ok",
    framing: "ok"
  });
  const service = createCalibrationService({
    runtime: {
      createMoondream: async () => ({
        id: "moondream",
        model: "fixture-v1",
        supports: () => true,
        async execute() {
          return {
            capability: "query",
            result: { capability: "query", text: shorthandAnswer },
            provider: "moondream",
            model: "fixture-v1"
          };
        }
      })
    },
    now: () => "2026-08-28T12:00:01.000Z",
    idFactory: () => "cal-run-shorthand"
  });

  const result = await service.calibrate(image());
  assert.equal(result.assessment, "suitable");
  assert.deepEqual(result.checks.map((check) => [check.id, check.state, check.message]), [
    ["lighting", "ok", "Lighting and exposure are usable."],
    ["obstruction", "ok", "The useful scene is not materially obstructed."],
    ["focus", "ok", "Image focus is usable."],
    ["glare", "ok", "Glare and reflections are acceptable."],
    ["framing", "ok", "Image framing is generally usable."]
  ]);
});

test("input calibration uses deterministic wording when a structured state omits its note", async () => {
  const service = createCalibrationService({
    runtime: {
      createMoondream: async () => ({
        id: "moondream",
        model: "fixture-v1",
        supports: () => true,
        async execute() {
          return {
            capability: "query",
            result: { capability: "query", text: JSON.stringify({
              lighting: { state: "warning" },
              obstruction: { state: "ok", note: "The scene is clear." },
              focus: { state: "ok", note: "Focus is usable." },
              glare: { state: "ok", note: "No material glare." },
              framing: { state: "ok", note: "Framing is usable." }
            }) },
            provider: "moondream",
            model: "fixture-v1"
          };
        }
      })
    },
    idFactory: () => "cal-run-structured"
  });

  const result = await service.calibrate(image());
  assert.equal(result.checks[0].state, "warning");
  assert.equal(result.checks[0].message, "Lighting or exposure may reduce visual reliability.");
});

test("localhost calibration endpoint accepts the current Input image bytes and remains POST-only", async (t) => {
  const calibration = {
    async calibrate(inputImage) {
      assert.equal(inputImage.mimeType, "image/png");
      assert.equal(inputImage.width, 2);
      assert.equal(inputImage.height, 2);
      assert.match(inputImage.source.sourceId, /visible-input/u);
      return {
        runId: "cal-run",
        planId: "input-moondream-readiness",
        planVersion: 2,
        assessment: "suitable",
        checks: [{ id: "lighting", state: "ok", message: "Lighting is usable.", evidenceIds: ["cal-run:lighting"] }],
        evidence: [],
        providerCalls: [{ capability: "query", provider: "moondream", model: "fixture-v1", status: "success" }],
        createdAt: "2026-08-28T12:00:01.000Z"
      };
    }
  };
  const { server } = createPortusQcHttpServer({ calibration, startedAt: "2026-08-28T12:00:00.000Z" });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${address.port}/api/calibration`;
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer();

  const response = await fetch(url, { method: "POST", headers: { "content-type": "image/png" }, body: png });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).calibration.assessment, "suitable");

  const wrongMethod = await fetch(url);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
});
