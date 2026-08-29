import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CamsnapCameraAdapter,
  CamsnapOperationalError,
  classifyCamsnapFailure,
  parseCamsnapDiscovery
} from "../src/index.ts";
import { CamsnapCliRuntime, runCamsnapProcess } from "../src/node-runtime.ts";

const camera = { id: "camera-1", name: "Receiving", host: "192.168.1.10", transport: "tcp" };

class FakeRuntime {
  discoveryCalls = 0;
  async discover() {
    this.discoveryCalls += 1;
    return { output: this.discoveryCalls === 1 ? "No devices found." : "192.168.1.10\t(add: camsnap add ...)" };
  }
  async probe() { return { ok: true, output: "ok" }; }
  async snapshot() { return { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", width: 1280, height: 720, capturedAt: "2026-08-27T18:00:00Z" }; }
  async clip() { return { bytes: new Uint8Array([4, 5, 6]), mimeType: "video/mp4", capturedAt: "2026-08-27T18:00:00Z" }; }
}

function minimalJpeg(width = 3, height = 2) {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9
  ]);
}

test("public Camsnap adapter discovers and captures with neutral engine provenance", async () => {
  const runtime = new FakeRuntime();
  const adapter = new CamsnapCameraAdapter({
    cameras: [camera],
    runtime,
    config: { discoveryAttempts: 2 },
    now: () => "2026-08-27T18:00:01Z"
  });

  const discovered = await adapter.discover();
  assert.equal(runtime.discoveryCalls, 2);
  assert.deepEqual(discovered, [{ id: "discovered:192.168.1.10", name: "192.168.1.10", host: "192.168.1.10" }]);

  const image = await adapter.snapshot("camera-1");
  assert.equal(image.width, 1280);
  assert.equal(image.height, 720);
  assert.equal(image.source.sourceId, "camera-1");
  assert.equal(image.source.receivedAt, "2026-08-27T18:00:01Z");
  assert.equal("siteId" in image.source, false);
  assert.equal("acquisitionKind" in image.source, false);
  assert.equal("credentialRef" in camera, false);
});

test("Camsnap camera validation rejects invalid runtime option values", () => {
  assert.throws(
    () => new CamsnapCameraAdapter({ cameras: [{ ...camera, transport: "serial" }], runtime: new FakeRuntime() }),
    /invalid transport/u
  );
});

test("public Camsnap parsing preserves discovery and auth/lockout distinctions", () => {
  assert.deepEqual(parseCamsnapDiscovery("192.168.0.2\n192.168.0.3:2020\nnot-an-address"), [
    { host: "192.168.0.2" },
    { host: "192.168.0.3", discoveryPort: 2020 }
  ]);
  assert.equal(classifyCamsnapFailure("Server is locked"), "server_locked");
  assert.equal(classifyCamsnapFailure("401 Unauthorized (auth)"), "auth_invalid");
});

test("Node Camsnap runtime drives isolated CLI config and converts snapshots without exposing credentials", async () => {
  const work = await mkdtemp(join(tmpdir(), "portus-camsnap-test-"));
  const calls = [];
  let credentialCalls = 0;
  const runner = async (executable, argv) => {
    calls.push({ executable, argv: [...argv] });
    const commandIndex = argv.findIndex((item) => ["add", "discover", "doctor", "snap", "clip"].includes(item));
    const command = argv[commandIndex];
    if (command === "snap") {
      const out = argv[argv.indexOf("--out") + 1];
      await writeFile(out, minimalJpeg(640, 480));
    }
    if (command === "clip") {
      const out = argv[argv.indexOf("--out") + 1];
      await writeFile(out, new Uint8Array([0, 1, 2, 3]));
    }
    return { exitCode: 0, stdout: "", stderr: command === "discover" ? "192.168.1.10\t(add: ...)" : "", timedOut: false };
  };

  try {
    const runtime = new CamsnapCliRuntime({
      configPath: join(work, "camsnap", "config.yaml"),
      executable: "bundled-camsnap",
      credentials: async () => {
        credentialCalls += 1;
        return { username: "camera-user", password: "super-secret" };
      },
      processRunner: runner,
      now: () => "2026-08-27T18:00:02Z"
    });

    const first = await runtime.snapshot(camera, { timeoutMs: 5_000 });
    const second = await runtime.snapshot(camera, { timeoutMs: 5_000 });
    const clip = await runtime.clip(camera, { timeoutMs: 5_000, durationMs: 250 });
    assert.equal(first.width, 640);
    assert.equal(first.height, 480);
    assert.equal(second.width, 640);
    assert.equal(clip.mimeType, "video/mp4");
    assert.equal(clip.bytes.byteLength, 4);
    assert.equal(credentialCalls, 1);
    assert.equal(calls.filter((call) => call.argv.includes("add")).length, 1);
    assert.equal(calls.filter((call) => call.argv.includes("snap")).length, 2);
    assert.equal(calls.filter((call) => call.argv.includes("clip")).length, 1);
    const addCall = calls.find((call) => call.argv.includes("add"));
    const snapCall = calls.find((call) => call.argv.includes("snap"));
    const clipCall = calls.find((call) => call.argv.includes("clip"));
    assert.ok(addCall);
    assert.ok(snapCall);
    assert.ok(clipCall);
    assert.equal(clipCall.argv[clipCall.argv.indexOf("--dur") + 1], "250ms");
    assert.equal(addCall.argv.includes("--rtsp-auth"), false, "camsnap add does not support --rtsp-auth");
    assert.equal(snapCall.argv.includes("--rtsp-auth"), false, "unset auth mode should not be synthesized");
    assert.ok(calls.every((call) => call.executable === "bundled-camsnap"));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("Node Camsnap runtime applies RTSP auth only to operations that support it", async () => {
  const work = await mkdtemp(join(tmpdir(), "portus-camsnap-auth-flags-"));
  const calls = [];
  const runner = async (executable, argv) => {
    calls.push([...argv]);
    if (argv.includes("snap")) await writeFile(argv[argv.indexOf("--out") + 1], minimalJpeg(16, 16));
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  try {
    const runtime = new CamsnapCliRuntime({
      configPath: join(work, "config.yaml"),
      executable: "bundled-camsnap",
      credentials: () => ({ username: "camera-user", password: "camera-pass" }),
      processRunner: runner
    });
    await runtime.snapshot({ ...camera, rtspClient: "gortsplib", rtspAuth: "digest" }, { timeoutMs: 5_000 });
    const addCall = calls.find((argv) => argv.includes("add"));
    const snapCall = calls.find((argv) => argv.includes("snap"));
    assert.ok(addCall);
    assert.ok(snapCall);
    assert.equal(addCall.includes("--rtsp-auth"), false);
    assert.deepEqual(snapCall.slice(snapCall.indexOf("--rtsp-auth"), snapCall.indexOf("--rtsp-auth") + 2), ["--rtsp-auth", "digest"]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("Node Camsnap process timeout terminates descendant processes", async () => {
  const work = await mkdtemp(join(tmpdir(), "portus-camsnap-tree-kill-"));
  const pidPath = join(work, "child.pid");
  let descendantPid;
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  };
  try {
    const childCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);`;
    const result = await runCamsnapProcess(process.execPath, ["-e", childCode, pidPath], 300);
    descendantPid = Number(await readFile(pidPath, "utf8"));
    assert.equal(result.timedOut, true);
    assert.equal(Number.isInteger(descendantPid), true);
    const deadline = Date.now() + 3_000;
    while (alive(descendantPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(descendantPid), false);
  } finally {
    if (Number.isInteger(descendantPid) && alive(descendantPid)) {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(descendantPid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
    }
    await rm(work, { recursive: true, force: true });
  }
});

test("Node Camsnap runtime normalizes process failures without leaking caller credentials", async () => {
  const work = await mkdtemp(join(tmpdir(), "portus-camsnap-failure-"));
  try {
    const runtime = new CamsnapCliRuntime({
      configPath: join(work, "config.yaml"),
      credentials: () => ({ username: "camera-user", password: "super-secret" }),
      processRunner: async () => ({ exitCode: 1, stdout: "", stderr: "401 Unauthorized super-secret", timedOut: false })
    });
    await assert.rejects(
      () => runtime.snapshot(camera, { timeoutMs: 5_000 }),
      (error) => {
        assert.ok(error instanceof CamsnapOperationalError);
        assert.equal(error.code, "auth_invalid");
        assert.doesNotMatch(error.message, /super-secret/u);
        return true;
      }
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
