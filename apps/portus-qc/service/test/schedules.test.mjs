import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLocalApplicationState } from "../src/local-state.ts";
import { SqliteCameraRepository } from "../src/persistence/cameras.ts";
import { SqliteScheduleRepository } from "../src/persistence/schedules.ts";
import { createScheduleService, MAX_SCHEDULED_TASKS } from "../src/domain/schedules.ts";
import { createPortusQcHttpServer } from "../src/server.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-schedules-"));
  const state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  t.after(async () => { state.close(); await rm(root, { recursive: true, force: true }); });
  const cameras = new SqliteCameraRepository(state.stateRepository, state.config.camera, () => "2026-08-28T12:00:00.000Z");
  await cameras.create({
    id: "camera-a", slot: 1, host: "192.168.1.10",
    protocol: "rtsp", stream: "stream1", transport: "tcp", rtspClient: "gortsplib", rtspAuth: "auto"
  });
  return { state, cameras, repository: new SqliteScheduleRepository(state.stateRepository, () => "2026-08-28T12:00:00.000Z") };
}

function flush() { return new Promise((resolve) => setImmediate(resolve)); }

test("persisted scheduler owns independent task prompts and drops overlap instead of queueing work", async (t) => {
  const { state, cameras, repository } = await fixture(t);
  let now = new Date("2026-08-28T12:00:00.000Z");
  let sequence = 0;
  const timers = new Map();
  let firstResolve;
  const firstRun = new Promise((resolve) => { firstResolve = resolve; });
  const runCalls = [];
  const service = createScheduleService({
    repository,
    cameras,
    runs: {
      async runScheduledTask(input) {
        runCalls.push(input);
        if (runCalls.length === 1) return firstRun;
        return { result: { id: `result-${runCalls.length}` } };
      }
    },
    config: state.config.scheduler,
    now: () => new Date(now),
    idFactory: () => "schedule-a",
    timers: {
      set(callback, delayMs) { const id = ++sequence; timers.set(id, { callback, delayMs }); return id; },
      clear(id) { timers.delete(id); }
    }
  });

  const saved = await service.create({ cameraId: "camera-a", prompt: "Find dents.", capability: "detect", intervalMs: 10_000, enabled: true });
  assert.equal(saved.id, "schedule-a");
  assert.equal(saved.prompt, "Find dents.");
  assert.equal(saved.capability, "detect");
  assert.equal(saved.nextRunAt, "2026-08-28T12:00:10.000Z");
  await service.start();
  assert.equal(timers.size, 1);

  const firstTimer = [...timers.values()][0];
  now = new Date("2026-08-28T12:00:10.000Z");
  firstTimer.callback();
  await flush();
  assert.deepEqual(runCalls[0], { cameraId: "camera-a", scheduleId: "schedule-a", prompt: "Find dents.", capability: "detect" });
  assert.equal((await repository.get("schedule-a")).nextRunAt, "2026-08-28T12:00:20.000Z");

  const secondTimer = [...timers.values()][0];
  now = new Date("2026-08-28T12:00:20.000Z");
  secondTimer.callback();
  await flush();
  const dropped = await repository.get("schedule-a");
  assert.equal(dropped.droppedCount, 1);
  assert.equal(dropped.lastStatus, "dropped");
  assert.equal(runCalls.length, 1);

  firstResolve({ result: { id: "result-1" } });
  await service.stop();
  const completed = await repository.get("schedule-a");
  assert.equal(completed.lastStatus, "completed");
  assert.equal(completed.lastResultId, "result-1");
  assert.equal(completed.enabled, true);
});

test("schedule HTTP surface creates, edits, arms, disarms, lists, and deletes first-class tasks", async (t) => {
  const { state, cameras, repository } = await fixture(t);
  const schedules = createScheduleService({
    repository,
    cameras,
    runs: { runScheduledTask: async () => ({ result: { id: "result" } }) },
    config: state.config.scheduler,
    idFactory: () => "schedule-http"
  });
  const { server } = createPortusQcHttpServer({ schedules, startedAt: "2026-08-28T12:00:00.000Z" });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const createdResponse = await fetch(`${base}/api/schedules`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cameraId: "camera-a", prompt: "Find apples.", capability: "detect", intervalMs: 60_000, enabled: false })
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).schedule;
  assert.equal(created.id, "schedule-http");
  assert.equal(created.enabled, false);
  assert.equal(created.prompt, "Find apples.");
  assert.equal("inspectionId" in created, false);

  const armedResponse = await fetch(`${base}/api/schedules/${created.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true })
  });
  assert.equal(armedResponse.status, 200);
  assert.equal((await armedResponse.json()).schedule.enabled, true);

  const editedResponse = await fetch(`${base}/api/schedules/${created.id}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cameraId: "camera-a", prompt: "Describe the scene.", capability: "caption", intervalMs: 120_000, enabled: false })
  });
  assert.equal(editedResponse.status, 200);
  const edited = (await editedResponse.json()).schedule;
  assert.equal(edited.prompt, "Describe the scene.");
  assert.equal(edited.capability, "caption");
  assert.equal(edited.intervalMs, 120_000);
  assert.equal(edited.enabled, false);

  const listResponse = await fetch(`${base}/api/schedules`);
  assert.equal(listResponse.status, 200);
  const payload = await listResponse.json();
  assert.equal(payload.schedules.length, 1);
  assert.equal(payload.policy.minIntervalMs, 10_000);
  assert.equal(payload.policy.maxIntervalMs, 86_400_000);
  assert.equal(payload.policy.overlapPolicy, "drop");
  assert.equal(payload.policy.maxSchedules, 10);

  const deletion = await fetch(`${base}/api/schedules/${created.id}`, { method: "DELETE" });
  assert.equal(deletion.status, 204);
  assert.equal((await (await fetch(`${base}/api/schedules`)).json()).schedules.length, 0);
});

test("scheduler enforces the ten-task limit in the service", async (t) => {
  const { state, cameras, repository } = await fixture(t);
  let id = 0;
  const service = createScheduleService({
    repository,
    cameras,
    runs: { runScheduledTask: async () => ({ result: { id: "unused" } }) },
    config: state.config.scheduler,
    idFactory: () => `schedule-${++id}`
  });

  for (let index = 0; index < MAX_SCHEDULED_TASKS; index += 1) {
    await service.create({
      cameraId: "camera-a",
      prompt: `Task ${index + 1}`,
      capability: "query",
      intervalMs: 60_000,
      enabled: false
    });
  }
  assert.equal((await service.list()).length, 10);
  await assert.rejects(
    () => service.create({ cameraId: "camera-a", prompt: "Task 11", capability: "query", intervalMs: 60_000, enabled: false }),
    /up to 10 scheduled tasks/u
  );
});
