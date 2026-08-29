import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { once } from "node:events";
import test from "node:test";
import sharp from "sharp";
import { prepareInferenceImage } from "@portus-qc/engine";
import { createVideoSessionService } from "../src/domain/video.ts";
import { createFfmpegFrameExtractor } from "../src/runtime/video.ts";
import { createPortusQcHttpServer } from "../src/server.ts";

function nextTurn() { return new Promise((resolve) => setImmediate(resolve)); }

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error(message);
}

test("FFmpeg video frame extraction returns one normalized frame-extract image", async () => {
  const jpeg = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 30, b: 40 } } }).jpeg().toBuffer());
  const calls = [];
  const extractor = createFfmpegFrameExtractor({
    resolveExecutable: async () => "C:/tools/ffmpeg.exe",
    now: () => "2026-08-28T14:00:02.000Z",
    processRunner: async (executable, argv) => {
      calls.push({ executable, argv: [...argv] });
      const inputPath = argv[argv.indexOf("-i") + 1];
      const outputPath = argv.at(-1);
      await access(inputPath);
      await writeFile(outputPath, jpeg);
      return { exitCode: 0, stderr: "", timedOut: false };
    }
  });

  const image = await extractor.extract({
    clip: {
      bytes: new Uint8Array([0, 1, 2, 3]),
      mimeType: "video/mp4",
      source: { sourceId: "receiving", capturedAt: "2026-08-28T14:00:01.000Z", receivedAt: "2026-08-28T14:00:01.100Z" }
    },
    cameraId: "receiving",
    sessionId: "video-session-1",
    frameId: "video-session-1-frame-1",
    frameTimestampMs: 2_000
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "C:/tools/ffmpeg.exe");
  assert.ok(calls[0].argv.includes("-frames:v"));
  assert.equal(image.width, 64);
  assert.equal(image.height, 48);
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.frameTimestampMs, 2_000);
  assert.equal(image.coordinateSpace.transform, "frame-extract");
  assert.equal(image.source.sourceId, "receiving");
  assert.equal(image.source.metadata.videoSessionId, "video-session-1");
});

test("video session follows the Moondream live-video frame cadence, drops instead of queueing, and runs until Stop", async (t) => {
  const base = Date.parse("2026-08-28T14:00:00.000Z");
  let clock = base;
  let clips = 0;
  const clipDurations = [];
  let resolveInference;
  const pendingInference = new Promise((resolve) => { resolveInference = resolve; });
  const analyzed = [];

  const video = createVideoSessionService({
    cameras: {
      async get(id) { return { id, slot: 1, host: "camera.local", protocol: "rtsp", stream: "stream1", transport: "tcp", rtspClient: "gortsplib", rtspAuth: "auto", credentialsConfigured: true }; },
      async clip(cameraId, durationMs) {
        clips += 1;
        clipDurations.push(durationMs);
        clock += durationMs;
        await nextTurn();
        return { bytes: new Uint8Array([clips]), mimeType: "video/mp4", source: { sourceId: cameraId, capturedAt: new Date(clock).toISOString(), receivedAt: new Date(clock).toISOString() } };
      }
    },
    inspections: { async prepare(id) { return { inspection: { id, enabled: true }, execution: {} }; } },
    runs: {
      async runVideoFrame(input) {
        analyzed.push(input.image.id);
        return pendingInference;
      }
    },
    runtime: { resolveFfmpeg: async () => "ffmpeg", moondreamConfigured: async () => true },
    extractor: {
      async extract(input) {
        return prepareInferenceImage({
          id: input.frameId,
          bytes: new Uint8Array([1]),
          mimeType: "image/jpeg",
          width: 10,
          height: 10,
          orientationNormalized: true,
          source: { sourceId: input.cameraId, receivedAt: new Date(clock).toISOString() }
        });
      }
    },
    config: { schemaVersion: 1, framesPerSecond: 4, maxOutstandingInferences: 1 },
    nowMs: () => clock,
    sleep: async (delayMs) => { clock += delayMs; await nextTurn(); },
    idFactory: () => "video-session-1"
  });

  const { server } = createPortusQcHttpServer({ video });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => {
    await video.shutdown();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;

  const started = await fetch(`${url}/api/video/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cameraId: "receiving", inspectionId: "console-inspection" })
  });
  assert.equal(started.status, 201);
  const startedPayload = await started.json();
  assert.deepEqual(Object.keys(startedPayload), ["session"]);
  assert.equal(startedPayload.session.status, "running");
  assert.equal(startedPayload.session.framesPerSecond, 4);
  assert.equal("maxSessionDurationMs" in startedPayload.session, false);

  await waitFor(() => video.status()?.framesDropped >= 2, "Video session did not apply drop-not-queue backpressure.");
  const active = await fetch(`${url}/api/video/session`);
  const activePayload = await active.json();
  assert.deepEqual(Object.keys(activePayload), ["session"]);
  assert.equal(activePayload.session.status, "running");
  assert.equal(activePayload.session.framesPerSecond, 4);
  assert.equal(activePayload.session.clipsCaptured, 1);
  assert.equal(activePayload.session.framesExtracted, 1);
  assert.ok(activePayload.session.framesDropped >= 2);
  assert.deepEqual(clipDurations, [250], "Moondream's 4 fps launch video cadence must produce a 250ms frame opportunity");
  assert.deepEqual(analyzed, ["video-session-1-frame-1"]);

  const stopping = fetch(`${url}/api/video/session`, { method: "DELETE" });
  await waitFor(() => video.status()?.status === "stopping", "Video session did not enter stopping state.");
  resolveInference({ status: "completed", result: { id: "video-result-1" }, artifact: { status: "exported" }, warnings: [] });
  const stopped = await stopping;
  assert.equal(stopped.status, 200);
  const stoppedPayload = await stopped.json();
  assert.deepEqual(Object.keys(stoppedPayload), ["session"]);
  assert.equal(stoppedPayload.session.status, "completed");
  assert.equal(stoppedPayload.session.framesAnalyzed, 1);
  assert.equal(stoppedPayload.session.framesFailed, 0);
  assert.equal(stoppedPayload.session.latestResultId, "video-result-1");
});
