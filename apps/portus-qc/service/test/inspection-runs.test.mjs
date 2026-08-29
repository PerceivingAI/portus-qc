import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { MoondreamVisionProvider, VisionProviderError } from "@portus-qc/vision";
import { createArtifactService } from "../src/domain/artifacts.ts";
import { createInspectionRunService, InspectionRunError } from "../src/domain/inspection-runs.ts";
import { createInspectionService } from "../src/domain/inspections.ts";
import { createResultService } from "../src/domain/results.ts";
import { openLocalApplicationState } from "../src/local-state.ts";
import { SqliteInspectionRepository } from "../src/persistence/inspections.ts";
import { SqliteResultRepository } from "../src/persistence/results.ts";
import { createPortusQcHttpServer } from "../src/server.ts";

const nativePayloads = {
  query: { request_id: "req-query", answer: "A dark blemish is visible on one apple." },
  caption: { request_id: "req-caption", caption: "Red apples moving along a conveyor." },
  detect: { request_id: "req-detect", objects: [{ x_min: 0.1, y_min: 0.2, x_max: 0.4, y_max: 0.6 }] },
  point: { request_id: "req-point", points: [{ x: 0.25, y: 0.75 }] },
  segment: { request_id: "req-segment", path: "M 0 0 L 1 0 L 1 1 L 0 1 Z", bbox: { x_min: 0.5, y_min: 0.5, x_max: 0.9, y_max: 0.9 } }
};

async function pngFixture() {
  const scene = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80">
    <rect width="120" height="80" fill="#d8d8d8"/>
    <rect y="58" width="120" height="12" fill="#6f6f6f"/>
    <circle cx="30" cy="38" r="17" fill="#d83a2f"/>
    <circle cx="70" cy="36" r="18" fill="#c9362b"/>
    <circle cx="100" cy="42" r="15" fill="#df4938"/>
    <circle cx="77" cy="42" r="4" fill="#4a2519"/>
  </svg>`);
  return new Uint8Array(await sharp(scene).png().toBuffer());
}

async function startServer(input) {
  const { server } = createPortusQcHttpServer(input);
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function collectFiles(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  return files;
}

test("S9 capture/process path executes all five native capabilities once and persists source/result/artifact for API retrieval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-s9-matrix-"));
  let state = await openLocalApplicationState({
    environment: { PORTUS_QC_DATA_ROOT: join(root, "data") },
    homeDirectory: join(root, "home")
  });
  let reopened;
  let running;
  t.after(async () => {
    if (running) await new Promise((resolve, reject) => running.server.close((error) => error ? reject(error) : resolve()));
    reopened?.close();
    state.close();
    await rm(root, { recursive: true, force: true });
  });

  const sourceBytes = await pngFixture();
  const inspections = createInspectionService(new SqliteInspectionRepository(state.stateRepository));
  const resultRepository = new SqliteResultRepository(state.stateRepository);
  const artifactRoot = join(root, "exports");
  const artifacts = createArtifactService({
    initialRoot: artifactRoot,
    defaultRoot: state.paths.defaultArtifactRoot,
    initialConfiguredRoot: artifactRoot,
    results: resultRepository,
    media: state.media,
    settingsRepository: state.settings,
    folderPicker: { pick: async () => undefined }
  });
  const results = createResultService({ results: resultRepository, media: state.media });
  const calls = [];
  const provider = new MoondreamVisionProvider({
    apiKey: "fixture-key",
    model: "moondream3.1-9B-A2B",
    fetchImpl: async (url, init) => {
      const capability = new URL(String(url)).pathname.split("/").at(-1);
      calls.push({ capability, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(nativePayloads[capability]), { status: 200 });
    }
  });
  let captures = 0;
  const capturedCameraIds = [];
  const cameras = {
    async snapshot(cameraId) {
      captures += 1;
      capturedCameraIds.push(cameraId);
      return {
        id: `capture-${captures}`,
        bytes: sourceBytes,
        mimeType: "image/png",
        width: 120,
        height: 80,
        source: { sourceId: cameraId, capturedAt: `2026-08-28T01:00:0${captures}.000Z`, receivedAt: `2026-08-28T01:00:0${captures}.000Z` }
      };
    }
  };
  const runtime = { createMoondream: async () => provider };
  let sequence = 0;
  const runs = createInspectionRunService({
    cameras,
    inspections,
    runtime,
    results: resultRepository,
    artifacts,
    media: state.media,
    mediaConfig: state.config.media,
    now: () => `2026-08-28T01:01:0${sequence + 1}.000Z`,
    idFactory: () => `result-${++sequence}`
  });

  const capabilities = ["query", "detect", "segment", "point", "caption"];
  for (const capability of capabilities) {
    await inspections.create({
      id: `inspection-${capability}`,
      name: `${capability} inspection`,
      prompt: "Find blemishes on the apples.",
      capability
    });
  }

  running = await startServer({ runs, results });
  for (const capability of capabilities) {
    const capturesBefore = captures;
    const providerCallsBefore = calls.length;
    const captureResponse = await fetch(`${running.url}/api/runs/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cameraId: "receiving", inspectionId: `inspection-${capability}` })
    });
    assert.equal(captureResponse.status, 201);
    assert.match(captureResponse.headers.get("content-type") || "", /^application\/json/u);
    const capturePayload = await captureResponse.json();
    const captureId = capturePayload.captureId;
    assert.ok(captureId);
    assert.deepEqual(Object.keys(capturePayload).sort(), ["captureId"], "Capture transport must not send captured image bytes to the Console");
    assert.equal(captures, capturesBefore + 1, "image Capture must take exactly one camera snapshot");
    assert.equal(calls.length, providerCallsBefore, "image Capture must not send inference before Process");

    const response = await fetch(`${running.url}/api/runs/${encodeURIComponent(captureId)}/process`, { method: "POST" });
    assert.equal(response.status, 201);
    assert.equal(captures, capturesBefore + 1, "Process must reuse the already captured image instead of taking another snapshot");
    assert.equal(calls.length, providerCallsBefore + 1, "Process must send the captured image to exactly one capability request");
    const payload = await response.json();
    assert.equal(payload.status, "completed");
    assert.equal(payload.result.capability, capability);
    assert.equal(payload.result.result.capability, capability);
    assert.equal(payload.result.source.available, true);
    assert.equal(payload.result.artifact.exported, true);
    assert.equal(payload.artifact.status, "exported");
    assert.deepEqual(payload.warnings, []);
    assert.equal("sourceMediaRef" in payload.result, false);
    assert.equal("artifactRef" in payload.result, false);
  }

  const unsupportedFileResponse = await fetch(`${running.url}/api/runs/file`, {
    method: "POST",
    headers: {
      "content-type": "image/webp",
      "x-portus-qc-inspection-id": encodeURIComponent("inspection-query"),
      "x-portus-qc-file-name": encodeURIComponent("unsupported.webp")
    },
    body: new Uint8Array([1, 2, 3])
  });
  assert.equal(unsupportedFileResponse.status, 415, "File route must reject formats outside JPEG/PNG even if the picker is bypassed");
  assert.equal(captures, 5, "Rejected file input must not invoke camera capture");
  assert.equal(calls.length, 5, "Rejected file input must not invoke Moondream");

  const fileCapturesBefore = captures;
  const fileCallsBefore = calls.length;
  const fileCaptureResponse = await fetch(`${running.url}/api/runs/file`, {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-portus-qc-inspection-id": encodeURIComponent("inspection-query"),
      "x-portus-qc-file-name": encodeURIComponent("sample apples.png")
    },
    body: sourceBytes
  });
  assert.equal(fileCaptureResponse.status, 201);
  const fileCapturePayload = await fileCaptureResponse.json();
  assert.deepEqual(Object.keys(fileCapturePayload).sort(), ["captureId"]);
  assert.equal(captures, fileCapturesBefore, "File selection must not invoke camera capture");
  assert.equal(calls.length, fileCallsBefore, "File ingestion must not invoke Moondream before Process");

  const fileProcessResponse = await fetch(`${running.url}/api/runs/${encodeURIComponent(fileCapturePayload.captureId)}/process`, { method: "POST" });
  assert.equal(fileProcessResponse.status, 201);
  assert.equal(captures, fileCapturesBefore, "File Process must not invoke camera capture");
  assert.equal(calls.length, fileCallsBefore + 1, "File Process must issue exactly one selected-capability request");
  const filePayload = await fileProcessResponse.json();
  assert.equal(filePayload.result.inputMode, "image");
  assert.equal("cameraId" in filePayload.result, false);
  assert.match(filePayload.result.sourceId, /^file:result-6:sample apples\.png$/u);
  assert.equal(filePayload.result.source.available, true);
  const normalizedFileSource = await fetch(`${running.url}${filePayload.result.source.url}`);
  assert.equal(normalizedFileSource.status, 200);
  assert.equal(normalizedFileSource.headers.get("content-type"), "image/png");
  const normalizedMetadata = await sharp(new Uint8Array(await normalizedFileSource.arrayBuffer())).metadata();
  assert.equal(normalizedMetadata.width, 120);
  assert.equal(normalizedMetadata.height, 80);

  const scheduled = await runs.runScheduledTask({
    cameraId: "receiving",
    scheduleId: "schedule-apples",
    prompt: "Find green apples.",
    capability: "detect"
  });
  assert.equal(scheduled.status, "completed");
  assert.equal(scheduled.result.triggerMode, "scheduled");
  assert.equal(scheduled.result.cameraId, "receiving");
  assert.equal(scheduled.result.inspectionId, "schedule-apples");
  assert.equal(scheduled.result.prompt, "Find green apples.");
  assert.equal(scheduled.result.capability, "detect");

  assert.equal(captures, 6);
  assert.deepEqual(capturedCameraIds, ["receiving", "receiving", "receiving", "receiving", "receiving", "receiving"]);
  assert.equal(calls.length, 7);
  assert.deepEqual(calls.map((call) => call.capability), [...capabilities, "query", "detect"]);
  for (const call of calls.slice(0, -1)) {
    if (call.capability === "query") assert.equal(call.body.question, "Find blemishes on the apples.");
    else if (call.capability === "caption") {
      assert.equal("question" in call.body, false);
      assert.equal("object" in call.body, false);
    } else assert.equal(call.body.object, "Find blemishes on the apples.");
  }
  assert.equal(calls.at(-1).body.object, "Find green apples.");

  const stored = await resultRepository.listRecent(7);
  assert.equal(stored.length, 7);
  for (const result of stored) {
    assert.ok(result.sourceMediaRef);
    assert.ok(result.artifactRef);
    if (result.id === "result-6") assert.equal(result.cameraId, undefined);
    else assert.equal(result.cameraId, "receiving");
    assert.equal(result.inputMode, "image");
    assert.equal(result.triggerMode, result.id === "result-7" ? "scheduled" : "on-demand");
    await access(result.artifactRef);
    if (result.id !== "result-6") assert.deepEqual(await state.media.read(result.sourceMediaRef), sourceBytes);
    if (result.capability === "query" || result.capability === "caption") {
      assert.equal(extname(result.artifactRef), ".txt");
      assert.match(await readFile(result.artifactRef, "utf8"), /apple|conveyor/iu);
    } else {
      assert.equal(extname(result.artifactRef), ".png");
      const metadata = await sharp(result.artifactRef).metadata();
      assert.equal(metadata.width, 120);
      assert.equal(metadata.height, 80);
    }
  }

  const currentResponse = await fetch(`${running.url}/api/results/current`);
  assert.equal(currentResponse.status, 200);
  const current = (await currentResponse.json()).result;
  assert.equal(current.id, "result-7");
  assert.equal(current.capability, "detect");
  assert.equal(current.triggerMode, "scheduled");
  const sourceResponse = await fetch(`${running.url}${current.source.url}`);
  assert.equal(sourceResponse.status, 200);
  assert.equal(sourceResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await sourceResponse.arrayBuffer()), sourceBytes);

  const videoRun = await runs.runVideoFrame({
    cameraId: "receiving",
    inspectionId: "inspection-query",
    image: {
      id: "video-frame-1",
      bytes: sourceBytes,
      mimeType: "image/png",
      width: 120,
      height: 80,
      frameTimestampMs: 2_000,
      source: { sourceId: "receiving", capturedAt: "2026-08-28T01:02:00.000Z", receivedAt: "2026-08-28T01:02:00.100Z" },
      coordinateSpace: { sourceWidth: 120, sourceHeight: 80, inferenceWidth: 120, inferenceHeight: 80, orientationNormalized: true, transform: "frame-extract" }
    }
  });
  assert.equal(videoRun.result.id, "result-8");
  assert.equal(videoRun.result.inputMode, "video-frame");
  assert.equal(videoRun.result.triggerMode, "on-demand");
  const videoStored = await resultRepository.get("result-8");
  assert.equal(videoStored.sourceId, "video-frame-1");
  assert.match(videoStored.sourceMediaRef, /\/frame\//u);
  assert.deepEqual(await state.media.read(videoStored.sourceMediaRef), sourceBytes);

  await new Promise((resolve, reject) => running.server.close((error) => error ? reject(error) : resolve()));
  running = undefined;
  state.close();
  reopened = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: join(root, "data") }, homeDirectory: join(root, "home") });
  const reopenedResults = new SqliteResultRepository(reopened.stateRepository);
  assert.equal((await reopenedResults.listRecent(8)).length, 8);
  assert.equal((await reopenedResults.get("result-3")).capability, "segment");
});

test("S9 cleans uncommitted captures on inference/persistence failure but keeps committed results when artifact export fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-s9-failures-"));
  const state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  const sourceBytes = await pngFixture();
  const inspection = {
    id: "query-check",
    name: "Query check",
    prompt: "What is visible?",
    enabled: true,
    capability: "query"
  };
  const inspections = {
    async prepare() { return { inspection, execution: { id: inspection.id, name: inspection.name, prompt: inspection.prompt, capability: inspection.capability } }; }
  };
  const cameras = {
    async snapshot() {
      return { id: "capture-failure", bytes: sourceBytes, mimeType: "image/png", width: 120, height: 80, source: { sourceId: "camera", receivedAt: "2026-08-28T02:00:00.000Z" } };
    }
  };

  let sequence = 0;
  const failedProviderRuns = createInspectionRunService({
    cameras,
    inspections,
    runtime: { createMoondream: async () => ({
      id: "moondream",
      model: "fixture",
      supports: () => true,
      execute: async () => { throw new VisionProviderError("request_failed", "fixture failure"); }
    }) },
    results: new SqliteResultRepository(state.stateRepository),
    artifacts: { exportResult: async () => { throw new Error("must not export"); } },
    media: state.media,
    mediaConfig: state.config.media,
    idFactory: () => `failed-provider-${++sequence}`,
    now: () => "2026-08-28T02:00:00.000Z"
  });
  await assert.rejects(
    () => failedProviderRuns.runOnDemand({ cameraId: "camera", inspectionId: "query-check" }),
    (error) => error instanceof InspectionRunError && error.code === "provider_failed"
  );
  assert.equal((await collectFiles(state.paths.mediaRoot)).length, 0);

  let deleted = false;
  const persistenceRuns = createInspectionRunService({
    cameras,
    inspections,
    runtime: { createMoondream: async () => ({
      id: "moondream", model: "fixture", supports: () => true,
      execute: async () => ({ capability: "query", result: { capability: "query", text: "ok" }, provider: "moondream", model: "fixture" })
    }) },
    results: { create: async () => { throw new Error("db failed"); } },
    artifacts: { exportResult: async () => { throw new Error("must not export"); } },
    media: {
      root: state.media.root,
      save: (...args) => state.media.save(...args),
      read: (...args) => state.media.read(...args),
      async delete(path) { deleted = true; await state.media.delete(path); }
    },
    mediaConfig: state.config.media,
    idFactory: () => "failed-persistence",
    now: () => "2026-08-28T02:01:00.000Z"
  });
  await assert.rejects(
    () => persistenceRuns.runOnDemand({ cameraId: "camera", inspectionId: "query-check" }),
    (error) => error instanceof InspectionRunError && error.code === "persistence_failed"
  );
  assert.equal(deleted, true);

  const results = new SqliteResultRepository(state.stateRepository);
  const artifactFailureRuns = createInspectionRunService({
    cameras,
    inspections,
    runtime: { createMoondream: async () => ({
      id: "moondream", model: "fixture", supports: () => true,
      execute: async () => ({ capability: "query", result: { capability: "query", text: "committed" }, provider: "moondream", model: "fixture" })
    }) },
    results,
    artifacts: { exportResult: async () => { throw new Error("disk unavailable"); } },
    media: state.media,
    mediaConfig: state.config.media,
    idFactory: () => "artifact-failure",
    now: () => "2026-08-28T02:02:00.000Z"
  });
  const completed = await artifactFailureRuns.runOnDemand({ cameraId: "camera", inspectionId: "query-check" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.artifact.status, "failed");
  assert.equal(completed.warnings[0].code, "artifact_export_failed");
  const persisted = await results.get("artifact-failure");
  assert.equal(persisted.result.text, "committed");
  assert.ok(persisted.sourceMediaRef);
  assert.deepEqual(await state.media.read(persisted.sourceMediaRef), sourceBytes);
});
