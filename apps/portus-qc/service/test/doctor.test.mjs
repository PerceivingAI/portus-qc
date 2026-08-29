import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDoctor } from "../src/doctor/checks.ts";
import { openLocalApplicationState } from "../src/local-state.ts";
import { secretKeys } from "../src/secrets/store.ts";

function fakeRuntime(state, options = {}) {
  return {
    createEngine: async () => { throw new Error("not used by doctor"); },
    createMoondream: async () => { throw new Error("not used by doctor"); },
    withCamsnap: () => { throw new Error("not used by doctor"); },
    moondreamConfigured: () => state.secrets.has(secretKeys.moondreamApiKey),
    probeCamsnap: async () => options.camsnap ?? {
      executable: "camsnap",
      resolvedPath: "C:/tools/camsnap.exe",
      available: true,
      version: "camsnap 0.2.0"
    },
    probeFfmpeg: async () => options.ffmpeg ?? {
      executable: "ffmpeg",
      resolvedPath: "C:/tools/ffmpeg.exe",
      available: true,
      version: "ffmpeg version 8.0"
    }
  };
}

test("doctor is degraded until Moondream is configured and never returns secret material", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-doctor-"));
  const state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });

  const first = await runDoctor(state, fakeRuntime(state), {
    nodeVersion: "v22.13.0",
    now: () => "2026-08-27T00:00:00.000Z"
  });
  assert.equal(first.status, "degraded");
  assert.equal(first.checks.find((check) => check.id === "moondream")?.status, "attention");

  const secret = "super-secret-do-not-leak";
  await state.secrets.set(secretKeys.moondreamApiKey, secret);
  const ready = await runDoctor(state, fakeRuntime(state), {
    nodeVersion: "v22.13.0",
    now: () => "2026-08-27T00:00:00.000Z"
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.checkedAt, "2026-08-27T00:00:00.000Z");
  assert.equal(JSON.stringify(ready).includes(secret), false);
  assert.equal(ready.checks.find((check) => check.id === "data_directory")?.status, "ok");
});

test("doctor includes saved-camera reachability status without exposing camera credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-doctor-cameras-"));
  const state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  await state.secrets.set(secretKeys.moondreamApiKey, "configured-moonda");
  const cameras = {
    list: async () => [{ id: "line-a", name: "Line A", host: "192.168.1.10", protocol: "rtsp", stream: "stream1", transport: "tcp", rtspClient: "gortsplib", rtspAuth: "auto", credentialsConfigured: true }],
    test: async () => ({ cameraId: "line-a", reachable: false, checkedAt: "2026-08-28T00:00:00.000Z", reason: "auth_invalid" })
  };
  const report = await runDoctor(state, fakeRuntime(state), { cameras });
  const camera = report.checks.find((check) => check.id === "camera");
  assert.equal(camera?.status, "attention");
  assert.equal(camera?.details?.cameraId, "line-a");
  assert.equal(camera?.details?.reason, "auth_invalid");
  assert.equal(JSON.stringify(report).includes("password"), false);
});

test("doctor distinguishes hard local runtime failures from missing optional runtime tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-doctor-errors-"));
  const state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });

  const oldNode = await runDoctor(state, fakeRuntime(state, {
    camsnap: { executable: "camsnap", available: false, error: "not_found" },
    ffmpeg: { executable: "ffmpeg", available: false, error: "not_found" }
  }), { nodeVersion: "v22.12.0" });

  assert.equal(oldNode.status, "error");
  assert.equal(oldNode.checks.find((check) => check.id === "node")?.status, "error");
  assert.equal(oldNode.checks.find((check) => check.id === "camsnap")?.status, "attention");
  assert.equal(oldNode.checks.find((check) => check.id === "ffmpeg")?.status, "attention");
});
