import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLocalApplicationState } from "../src/local-state.ts";
import { SqliteResultRepository } from "../src/persistence/results.ts";

async function openTestState(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, state };
}

function base(overrides = {}) {
  return {
    id: "result-1",
    createdAt: "2026-08-27T12:00:00.000Z",
    cameraId: "camera-1",
    sourceId: "frame-1",
    inspectionId: "apple-blemish",
    inspectionName: "Apple blemish",
    prompt: "Find blemishes on the apples.",
    capability: "query",
    inputMode: "image",
    triggerMode: "on-demand",
    provider: "moondream",
    model: "moondream3.1-9B-A2B",
    requestId: "request-1",
    durationMs: 42.5,
    result: { capability: "query", text: "A small dark blemish is visible." },
    sourceMediaRef: "captures/frame-1.jpg",
    ...overrides
  };
}

test("result repository persists authoritative text result metadata and later artifact reference across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-results-restart-"));
  let state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  let reopened;
  t.after(async () => {
    reopened?.close();
    state.close();
    await rm(root, { recursive: true, force: true });
  });

  let repository = new SqliteResultRepository(state.stateRepository);
  assert.equal(await repository.create(base()), true);
  assert.equal(await repository.setArtifactReference("result-1", "Downloads/portus-qc-results/result-1.txt"), true);
  state.close();

  reopened = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  repository = new SqliteResultRepository(reopened.stateRepository);
  assert.deepEqual(await repository.get("result-1"), {
    ...base(),
    artifactRef: "Downloads/portus-qc-results/result-1.txt"
  });
});

test("result repository round-trips caption, detect, point, and segment through typed relational storage", async (t) => {
  const { state } = await openTestState(t, "portus-qc-results-spatial-");
  const repository = new SqliteResultRepository(state.stateRepository);
  const values = [
    base({ id: "caption", capability: "caption", result: { capability: "caption", text: "Several red apples on a tray." } }),
    base({ id: "detect", capability: "detect", result: { capability: "detect", boxes: [
      { xMin: 0.1, yMin: 0.2, xMax: 0.3, yMax: 0.4 },
      { xMin: 0.5, yMin: 0.6, xMax: 0.7, yMax: 0.8 }
    ] } }),
    base({ id: "point", capability: "point", inputMode: "video-frame", result: { capability: "point", points: [{ x: 0.25, y: 0.75 }] } }),
    base({ id: "segment", capability: "segment", triggerMode: "scheduled", result: { capability: "segment", regions: [
      { path: "M0.1 0.2 L0.3 0.4 Z", bbox: { xMin: 0.1, yMin: 0.2, xMax: 0.3, yMax: 0.4 } },
      { path: "M0.5 0.5 L0.6 0.6 Z", bbox: { xMin: 0.5, yMin: 0.5, xMax: 0.7, yMax: 0.7 } }
    ] } })
  ];

  for (const value of values) assert.equal(await repository.create(value), true);
  for (const value of values) assert.deepEqual(await repository.get(value.id), value);

  assert.equal(state.stateRepository.database.prepare("SELECT COUNT(*) AS count FROM result_boxes").get().count, 2);
  assert.equal(state.stateRepository.database.prepare("SELECT COUNT(*) AS count FROM result_points").get().count, 1);
  assert.equal(state.stateRepository.database.prepare("SELECT COUNT(*) AS count FROM result_segment_regions").get().count, 2);
  assert.deepEqual((await repository.listRecent(4)).map((item) => item.id).sort(), ["caption", "detect", "point", "segment"]);
});

test("result repository rejects mismatched capability data and never overwrites an existing result id", async (t) => {
  const { state } = await openTestState(t, "portus-qc-results-validation-");
  const repository = new SqliteResultRepository(state.stateRepository);
  await assert.rejects(
    () => repository.create(base({ capability: "detect", result: { capability: "query", text: "wrong family" } })),
    /capability must match/u
  );
  await assert.rejects(
    () => repository.create(base({ id: "bad-box", capability: "detect", result: { capability: "detect", boxes: [{ xMin: -0.1, yMin: 0, xMax: 0.5, yMax: 0.5 }] } })),
    /normalized coordinate/u
  );
  await assert.rejects(
    () => repository.create(base({ id: "zero-box", capability: "detect", result: { capability: "detect", boxes: [{ xMin: 0.2, yMin: 0.1, xMax: 0.2, yMax: 0.5 }] } })),
    /positive width and height/u
  );
  await assert.rejects(
    () => repository.create(base({ id: "missing-source", capability: "point", sourceMediaRef: undefined, result: { capability: "point", points: [{ x: 0.2, y: 0.2 }] } })),
    /require a retained sourceMediaRef/u
  );
  await assert.rejects(
    () => repository.create(base({ id: "missing-segment-bbox", capability: "segment", result: { capability: "segment", regions: [{ path: "M0 0 L1 1" }] } })),
    /requires a normalized bounding box/u
  );

  const original = base();
  assert.equal(await repository.create(original), true);
  assert.equal(await repository.create(base({ prompt: "Must not overwrite.", result: { capability: "query", text: "replacement" } })), false);
  assert.deepEqual(await repository.get("result-1"), original);
  assert.throws(
    () => state.stateRepository.database.prepare("INSERT INTO result_boxes(result_id, ordinal, x_min, y_min, x_max, y_max) VALUES (?, ?, ?, ?, ?, ?)").run("result-1", 0, 0.1, 0.1, 0.2, 0.2),
    /requires detect capability/u
  );

  assert.equal(await repository.create(base({ id: "detect-valid", capability: "detect", result: { capability: "detect", boxes: [] } })), true);
  assert.throws(
    () => state.stateRepository.database.prepare("INSERT INTO result_boxes(result_id, ordinal, x_min, y_min, x_max, y_max) VALUES (?, ?, ?, ?, ?, ?)").run("detect-valid", 0, 0.2, 0.2, 0.2, 0.5),
    /positive area/u
  );
  assert.throws(
    () => state.stateRepository.database.prepare(`
      INSERT INTO results(id, created_at, source_id, inspection_id, inspection_name, prompt, capability, input_mode, trigger_mode, provider, model, text_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("spatial-without-source", "2026-08-27T12:00:00.000Z", "frame-x", "apple-blemish", "Apple blemish", "Find blemishes.", "point", "image", "on-demand", "moondream", "model", null),
    /require source media/u
  );
});
