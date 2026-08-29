import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CamsnapOperationalError } from "@portus-qc/camsnap";
import { createCameraService, CameraDomainError } from "../src/domain/cameras.ts";
import { openLocalApplicationState } from "../src/local-state.ts";
import { SqliteCameraRepository } from "../src/persistence/cameras.ts";
import { secretKeys } from "../src/secrets/store.ts";

function fakeRuntime() {
  const calls = [];
  let probeCalls = 0;
  let snapshotCalls = 0;
  return {
    calls,
    get probeCalls() { return probeCalls; },
    get snapshotCalls() { return snapshotCalls; },
    async withCamsnap(operation, credentials) {
      calls.push({ credentials });
      return operation({
        discover: async () => ({ output: "192.168.1.20\t(add: camsnap add ...)" }),
        probe: async (camera) => {
          probeCalls += 1;
          if (camera.host === "bad-auth.local") return { ok: false, output: "401 Unauthorized (auth)" };
          if (camera.host === "offline.local") return { ok: false, output: "connection refused" };
          return { ok: true, output: "ok" };
        },
        snapshot: async (camera) => {
          snapshotCalls += 1;
          if (camera.host === "bad-auth.local") throw new CamsnapOperationalError("auth_invalid", "Camera snapshot failed (auth_invalid).");
          if (camera.host === "offline.local") throw new CamsnapOperationalError("unreachable", "Camera snapshot failed (unreachable).");
          return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mimeType: "image/jpeg", width: 640, height: 480, capturedAt: "2026-08-28T12:00:00.000Z" };
        },
        clip: async () => ({ bytes: new Uint8Array([4]), mimeType: "video/mp4", capturedAt: "2026-08-28T12:00:00.000Z" })
      });
    }
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-cameras-"));
  const state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  const runtime = fakeRuntime();
  const repository = new SqliteCameraRepository(state.stateRepository, state.config.camera, () => "2026-08-28T00:00:00.000Z");
  let generated = 0;
  const service = createCameraService({ repository, secrets: state.secrets, runtime, defaults: state.config.camera, config: state.config, settingsRepository: state.settings, idFactory: () => `generated-${++generated}` });
  return { root, state, runtime, repository, service };
}

const connectInput = {
  slot: 1,
  alias: "Receiving",
  host: "192.168.1.10",
  username: "operator",
  password: " camera-secret "
};

test("camera persistence owns four ordered slots, optional aliases, and secret-only credentials", async (t) => {
  const { state, service } = await fixture(t);
  const created = await service.connect(connectInput);
  assert.equal(created.id, "generated-1");
  assert.equal(created.slot, 1);
  assert.equal(created.alias, "Receiving");
  assert.equal(created.protocol, "rtsp");
  assert.equal(created.stream, "stream1");
  assert.equal(created.transport, "tcp");
  assert.equal(created.credentialsConfigured, true);
  assert.equal("username" in created, false);
  assert.equal("password" in created, false);
  assert.equal(await state.secrets.get(secretKeys.cameraUsername("generated-1")), "operator");
  assert.equal(await state.secrets.get(secretKeys.cameraPassword("generated-1")), " camera-secret ");

  const sqlite = await readFile(state.paths.databasePath);
  assert.equal(sqlite.toString("utf8").includes("camera-secret"), false);

  const replaced = await service.replace("generated-1", {
    alias: "",
    host: "192.168.1.11",
    protocol: "rtsps",
    stream: "stream2",
    transport: "tcp",
    rtspClient: "gortsplib",
    rtspAuth: "digest"
  });
  assert.equal(replaced.host, "192.168.1.11");
  assert.equal("alias" in replaced, false);
  assert.equal(await state.secrets.get(secretKeys.cameraPassword("generated-1")), " camera-secret ");

  const columns = state.stateRepository.database.prepare("PRAGMA table_info(cameras)").all().map((row) => String(row.name));
  assert.deepEqual(columns, ["id", "slot", "alias", "host", "port", "protocol", "stream", "path", "transport", "rtsp_client", "rtsp_auth", "created_at", "updated_at"]);

  await service.delete("generated-1");
  await assert.rejects(() => service.get("generated-1"), (error) => error instanceof CameraDomainError && error.code === "not_found");
  assert.equal(await state.secrets.has(secretKeys.cameraUsername("generated-1")), false);
  assert.equal(await state.secrets.has(secretKeys.cameraPassword("generated-1")), false);
});

test("camera metadata, credentials, and selected camera persist across application restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-camera-restart-"));
  let state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  let reopened;
  t.after(async () => {
    reopened?.close();
    state?.close();
    await rm(root, { recursive: true, force: true });
  });

  const runtime = fakeRuntime();
  let generated = 0;
  let service = createCameraService({
    repository: new SqliteCameraRepository(state.stateRepository, state.config.camera),
    secrets: state.secrets,
    runtime,
    defaults: state.config.camera,
    config: state.config,
    settingsRepository: state.settings,
    idFactory: () => `restart-${++generated}`
  });
  await service.connect({ slot: 1, host: "192.168.1.10", username: "u1", password: "p1" });
  const selected = await service.connect({ slot: 2, alias: "Packing", host: "192.168.1.20", username: "operator-two", password: "secret-two" });
  await service.select(selected.id);
  assert.equal(await service.selectedId(), selected.id);
  assert.deepEqual(await service.credentials(selected.id), { username: "operator-two", password: "secret-two" });
  assert.deepEqual(await state.settings.load(), { console: { selectedCameraId: selected.id } });

  state.close();
  state = undefined;
  reopened = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  service = createCameraService({
    repository: new SqliteCameraRepository(reopened.stateRepository, reopened.config.camera),
    secrets: reopened.secrets,
    runtime,
    defaults: reopened.config.camera,
    config: reopened.config,
    settingsRepository: reopened.settings,
    idFactory: () => "unused"
  });

  assert.equal(reopened.config.console.selectedCameraId, selected.id);
  assert.equal(await service.selectedId(), selected.id);
  assert.equal((await service.get(selected.id)).host, "192.168.1.20");
  assert.equal((await service.get(selected.id)).alias, "Packing");
  assert.deepEqual(await service.credentials(selected.id), { username: "operator-two", password: "secret-two" });
});

test("Connect validates with exactly one production snapshot, persists only success, and failed auth saves nothing", async (t) => {
  const { state, runtime, service } = await fixture(t);
  const connected = await service.connect({
    slot: 2,
    host: "192.168.1.30",
    alias: "",
    username: "camera-user",
    password: "camera-pass"
  });
  assert.equal(connected.id, "generated-1");
  assert.equal(connected.slot, 2);
  assert.equal("alias" in connected, false);
  assert.equal(runtime.snapshotCalls, 1);
  assert.equal(runtime.probeCalls, 0, "Connect must not validate through Camsnap doctor/FFmpeg");
  assert.equal(await state.secrets.get(secretKeys.cameraUsername("generated-1")), "camera-user");

  await assert.rejects(
    () => service.connect({ slot: 3, host: "bad-auth.local", username: "bad", password: "bad-pass" }),
    (error) => {
      assert.ok(error instanceof CameraDomainError);
      assert.equal(error.code, "operation_failed");
      assert.equal(error.reason, "auth_invalid");
      assert.equal(error.message, "Camera connection failed.");
      return true;
    }
  );
  assert.equal(runtime.snapshotCalls, 2);
  assert.equal(runtime.probeCalls, 0);
  assert.equal(await state.secrets.has(secretKeys.cameraUsername("generated-2")), false);
  assert.deepEqual((await service.list()).map((camera) => camera.slot), [2]);

  await assert.rejects(
    () => service.connect({ slot: 2, host: "192.168.1.31", username: "other", password: "other-pass" }),
    (error) => error instanceof CameraDomainError && error.code === "conflict"
  );
  assert.equal(runtime.snapshotCalls, 2, "occupied slots must fail before touching the camera");
  assert.equal(runtime.probeCalls, 0);
});

test("camera slot movement swaps stable camera identities across the fixed four slots", async (t) => {
  const { state, service } = await fixture(t);
  const first = await service.connect(connectInput);
  const second = await service.connect({ slot: 2, alias: "Second", host: "192.168.1.20", username: "u2", password: "p2" });
  await service.move(first.id, 2);
  const ordered = await service.list();
  assert.deepEqual(ordered.map((camera) => [camera.slot, camera.id]), [[1, second.id], [2, first.id]]);
  assert.equal(await state.secrets.get(secretKeys.cameraUsername(first.id)), "operator");
  assert.equal(await state.secrets.get(secretKeys.cameraUsername(second.id)), "u2");

  await service.connect({ slot: 3, host: "192.168.1.30", username: "u3", password: "p3" });
  await service.connect({ slot: 4, host: "192.168.1.40", username: "u4", password: "p4" });
  assert.deepEqual((await service.list()).map((camera) => camera.slot), [1, 2, 3, 4]);
});

test("draft test, discovery, and snapshot remain ephemeral Camsnap operations", async (t) => {
  const { state, runtime, service } = await fixture(t);
  const draft = await service.testDraft({ host: "192.168.1.30", username: "draft-user", password: "draft-pass" });
  assert.equal(draft.reachable, true);
  assert.equal(runtime.probeCalls, 0);
  assert.equal(runtime.snapshotCalls, 1);
  assert.deepEqual(runtime.calls.at(-1).credentials, { username: "draft-user", password: "draft-pass" });
  assert.deepEqual(await service.list(), []);
  assert.equal(await state.secrets.has(secretKeys.cameraPassword("draft-camera")), false);

  const connected = await service.connect(connectInput);
  const savedStatus = await service.test(connected.id);
  assert.equal(savedStatus.reachable, true);
  assert.equal(runtime.probeCalls, 0, "saved-camera status must use the production snapshot path");
  const discovered = await service.discover();
  assert.deepEqual(discovered, [{ id: "discovered:192.168.1.20", name: "192.168.1.20", host: "192.168.1.20" }]);

  const image = await service.snapshot(connected.id);
  assert.equal(image.width, 640);
  assert.equal(image.height, 480);
  assert.equal(image.source.sourceId, connected.id);

  const clip = await service.clip(connected.id, 2_000);
  assert.equal(clip.mimeType, "video/mp4");
  assert.equal(clip.bytes.byteLength, 1);
  assert.equal(clip.source.sourceId, connected.id);
});
