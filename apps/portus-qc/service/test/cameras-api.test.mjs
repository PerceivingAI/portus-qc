import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCameraService } from "../src/domain/cameras.ts";
import { openLocalApplicationState } from "../src/local-state.ts";
import { SqliteCameraRepository } from "../src/persistence/cameras.ts";
import { createPortusQcHttpServer } from "../src/server.ts";

function minimalJpeg(width = 3, height = 2) {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9
  ]);
}

async function start(t) {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-camera-api-"));
  const state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  const runtime = {
    async withCamsnap(operation) {
      return operation({
        discover: async () => ({ output: "192.168.1.50:2020" }),
        probe: async () => ({ ok: true, output: "ok" }),
        snapshot: async () => ({ bytes: minimalJpeg(10, 10), mimeType: "image/jpeg", width: 10, height: 10, capturedAt: "2026-08-28T00:00:00.000Z" }),
        clip: async () => ({ bytes: new Uint8Array([1]), mimeType: "video/mp4", capturedAt: "2026-08-28T00:00:00.000Z" })
      });
    }
  };
  const cameras = createCameraService({
    repository: new SqliteCameraRepository(state.stateRepository, state.config.camera),
    secrets: state.secrets,
    runtime,
    defaults: state.config.camera,
    config: state.config,
    settingsRepository: state.settings,
    idFactory: () => "generated-camera"
  });
  const { server } = createPortusQcHttpServer({ cameras, startedAt: "2026-08-28T00:00:00.000Z" });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${address.port}`;
}

function json(method, body) {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

test("ordinary camera HTTP responses hide credentials while the protected Console edit read can load them", async (t) => {
  const url = await start(t);

  const discovery = await fetch(`${url}/api/cameras/_actions/discover`, { method: "POST" });
  assert.deepEqual((await discovery.json()).cameras, [{ id: "discovered:192.168.1.50:2020", name: "192.168.1.50:2020", host: "192.168.1.50", discoveryPort: 2020 }]);

  const legacyCreate = await fetch(`${url}/api/cameras`, json("POST", {
    slot: 1, host: "192.168.1.9", username: "legacy", password: "legacy-secret"
  }));
  assert.equal(legacyCreate.status, 405);
  assert.equal(legacyCreate.headers.get("allow"), "GET");

  const connectedResponse = await fetch(`${url}/api/cameras/_actions/connect`, json("POST", {
    slot: 1, alias: "Line 1", host: "192.168.1.10", username: "admin", password: "secret-value"
  }));
  assert.equal(connectedResponse.status, 201);
  const connectedText = await connectedResponse.text();
  assert.equal(connectedText.includes("secret-value"), false);
  assert.equal(connectedText.includes("admin"), false);
  const connected = JSON.parse(connectedText).camera;
  assert.equal(connected.id, "generated-camera");
  assert.equal(connected.slot, 1);
  assert.equal(connected.alias, "Line 1");
  assert.equal(connected.credentialsConfigured, true);

  const unprotectedCredentials = await fetch(`${url}/api/cameras/${connected.id}/credentials`);
  assert.equal(unprotectedCredentials.status, 403);
  assert.equal((await unprotectedCredentials.json()).error.code, "console_secret_request_required");

  const protectedCredentials = await fetch(`${url}/api/cameras/${connected.id}/credentials`, {
    headers: { "x-portus-qc-console-secret": "1" }
  });
  assert.equal(protectedCredentials.status, 200);
  assert.deepEqual((await protectedCredentials.json()).credentials, { username: "admin", password: "secret-value" });

  const selected = await fetch(`${url}/api/cameras/_actions/selection`, json("PUT", { cameraId: connected.id }));
  assert.equal(selected.status, 200);
  assert.deepEqual(await selected.json(), { cameraId: connected.id });
  assert.deepEqual(await (await fetch(`${url}/api/cameras/_actions/selection`)).json(), { cameraId: connected.id });

  const preview = await fetch(`${url}/api/cameras/${connected.id}/preview`, { method: "POST" });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/jpeg");
  assert.ok((await preview.arrayBuffer()).byteLength > 0);

  const moved = await fetch(`${url}/api/cameras/${connected.id}/slot`, json("PUT", { slot: 4 }));
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).camera.slot, 4);

  const probe = await fetch(`${url}/api/cameras/${connected.id}/test`, { method: "POST" });
  assert.equal(probe.status, 200);
  assert.equal((await probe.json()).probe.reachable, true);

  const listText = await (await fetch(`${url}/api/cameras`)).text();
  assert.equal(listText.includes("secret-value"), false);
  assert.equal(listText.includes("admin"), false);

  const deletion = await fetch(`${url}/api/cameras/${connected.id}`, { method: "DELETE" });
  assert.equal(deletion.status, 204);
});
