import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createArtifactService, ArtifactServiceError } from "../src/domain/artifacts.ts";
import { openLocalApplicationState } from "../src/local-state.ts";
import { SqliteResultRepository } from "../src/persistence/results.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-artifacts-"));
  const state = await openLocalApplicationState({
    environment: { PORTUS_QC_DATA_ROOT: join(root, "data") },
    homeDirectory: join(root, "home")
  });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  const results = new SqliteResultRepository(state.stateRepository);
  const artifactRoot = join(root, "exports");
  let picked = join(root, "picked");
  const service = createArtifactService({
    initialRoot: artifactRoot,
    defaultRoot: state.paths.defaultArtifactRoot,
    initialConfiguredRoot: artifactRoot,
    results,
    media: state.media,
    settingsRepository: state.settings,
    folderPicker: { pick: async () => picked }
  });
  return { root, state, results, service, setPicked: (value) => { picked = value; } };
}

function record(id, result, overrides = {}) {
  return {
    id,
    createdAt: "2026-08-27T12:34:56.000Z",
    sourceId: "source-1",
    inspectionId: "apple-check",
    inspectionName: "Apple check",
    prompt: "Find blemishes on the apples.",
    capability: result.capability,
    inputMode: "image",
    triggerMode: "on-demand",
    provider: "moondream",
    model: "moondream3.1-9B-A2B",
    result,
    ...overrides
  };
}

test("artifact service exports text, attaches the absolute reference, and exported-file deletion leaves SQLite intact", async (t) => {
  const { results, service } = await fixture(t);
  await results.create(record("query-1", { capability: "query", text: "The apples are red." }));

  const artifact = await service.exportResult("query-1");
  assert.equal(artifact.mimeType, "text/plain");
  assert.equal(await readFile(artifact.absolutePath, "utf8"), "The apples are red.\n");
  assert.equal((await results.get("query-1")).artifactRef, artifact.absolutePath);

  await rm(artifact.absolutePath, { force: true });
  await assert.rejects(() => access(artifact.absolutePath));
  const stored = await results.get("query-1");
  assert.equal(stored.id, "query-1");
  assert.equal(stored.result.text, "The apples are red.");
});

test("artifact service renders Detect, Point, and bbox-relative Segment results as PNG overlays", async (t) => {
  const { state, results, service } = await fixture(t);
  const sourceBytes = new Uint8Array(await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer());
  const storedMedia = await state.media.save({ id: "source-image", kind: "capture", bytes: sourceBytes, mimeType: "image/png", createdAt: "2026-08-27T12:34:55.000Z" });

  await results.create(record("detect-1", { capability: "detect", boxes: [{ xMin: 0.1, yMin: 0.1, xMax: 0.4, yMax: 0.4 }] }, { sourceMediaRef: storedMedia.relativePath }));
  await results.create(record("point-1", { capability: "point", points: [{ x: 0.5, y: 0.5 }] }, { sourceMediaRef: storedMedia.relativePath }));
  await results.create(record("segment-1", {
    capability: "segment",
    regions: [{ path: "M 0 0 L 1 0 L 1 1 L 0 1 Z", bbox: { xMin: 0.5, yMin: 0.5, xMax: 1, yMax: 1 } }]
  }, { sourceMediaRef: storedMedia.relativePath }));

  for (const id of ["detect-1", "point-1", "segment-1"]) {
    const artifact = await service.exportResult(id);
    assert.equal(artifact.mimeType, "image/png");
    const metadata = await sharp(artifact.absolutePath).metadata();
    assert.equal(metadata.width, 100);
    assert.equal(metadata.height, 100);
  }

  const segmentPath = (await results.get("segment-1")).artifactRef;
  const { data, info } = await sharp(segmentPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => {
    const offset = (y * info.width + x) * info.channels;
    return [...data.subarray(offset, offset + 3)];
  };
  assert.deepEqual(pixel(10, 10), [255, 255, 255]);
  assert.notDeepEqual(pixel(75, 75), [255, 255, 255]);
});

test("artifact root is editable, persisted, resettable, and folder-picker selections use the same setting", async (t) => {
  const { root, state, service, setPicked } = await fixture(t);
  const explicit = join(root, "custom-results");
  assert.deepEqual(await service.setRoot(explicit), { root: explicit, configuredRoot: explicit });
  assert.equal((await state.settings.load()).artifacts.root, explicit);

  const picked = join(root, "picked-results");
  setPicked(picked);
  const selection = await service.pickRoot();
  assert.equal(selection.selected, true);
  assert.equal(selection.settings.root, picked);
  assert.equal((await state.settings.load()).artifacts.root, picked);

  setPicked(undefined);
  const cancelled = await service.pickRoot();
  assert.equal(cancelled.selected, false);
  assert.equal(cancelled.settings.root, picked);

  await assert.rejects(() => service.setRoot("relative-results"), (error) => error instanceof ArtifactServiceError && error.code === "invalid_root");
  const defaults = await service.setRoot(null);
  assert.equal(defaults.configuredRoot, null);
  assert.match(defaults.root, /Downloads[\\/]portus-qc-results$/u);
});
