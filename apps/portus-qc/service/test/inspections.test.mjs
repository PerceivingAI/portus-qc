import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInspectionService, InspectionDomainError } from "../src/domain/inspections.ts";
import { openLocalApplicationState } from "../src/local-state.ts";
import { SqliteInspectionRepository } from "../src/persistence/inspections.ts";

async function withState(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, state };
}

test("inspection repository persists prompt and selected capability across application restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-inspections-"));
  const state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  let reopened;
  t.after(async () => {
    reopened?.close();
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  let service = createInspectionService(new SqliteInspectionRepository(state.stateRepository, () => "2026-08-27T00:00:00.000Z"));
  const created = await service.create({ id: "dent-check", name: "Dent check", prompt: "Look for dents.", capability: "detect" });
  assert.equal(created.enabled, true);
  assert.equal(created.capability, "detect");
  assert.deepEqual((await service.list()).map((item) => item.id), ["dent-check"]);

  await assert.rejects(
    () => service.create({ id: "dent-check", name: "Overwrite", prompt: "Must not overwrite." }),
    (error) => error instanceof InspectionDomainError && error.code === "conflict"
  );

  state.close();
  reopened = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  service = createInspectionService(new SqliteInspectionRepository(reopened.stateRepository));
  assert.equal((await service.get("dent-check")).capability, "detect");

  const replaced = await service.replace("dent-check", {
    name: "Can dents",
    prompt: "Look for visible dents on cans.",
    enabled: false,
    capability: "segment"
  });
  assert.equal(replaced.enabled, false);
  assert.equal(replaced.capability, "segment");

  await service.delete("dent-check");
  await assert.rejects(() => service.get("dent-check"), (error) => error instanceof InspectionDomainError && error.code === "not_found");
});

test("inspection service prepares one reusable prompt-capability execution definition", async (t) => {
  const { state } = await withState(t, "portus-qc-inspection-prepare-");
  const service = createInspectionService(new SqliteInspectionRepository(state.stateRepository));
  await service.create({ id: "apple-blemish", name: "Apple blemish", prompt: "Check apples for visible blemishes.", capability: "point" });
  const prepared = await service.prepare("apple-blemish");
  assert.deepEqual(prepared.execution, {
    id: "apple-blemish",
    name: "Apple blemish",
    prompt: "Check apples for visible blemishes.",
    capability: "point"
  });
  assert.equal("decision" in prepared.execution, false);
  assert.equal("output" in prepared.execution, false);

  await service.replace("apple-blemish", {
    name: "Apple blemish",
    prompt: "Check apples for visible blemishes.",
    enabled: false,
    capability: "point"
  });
  await assert.rejects(() => service.prepare("apple-blemish"), (error) => error instanceof InspectionDomainError && error.code === "disabled");
});
