import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMoondreamSettingsService } from "../src/domain/moondream-settings.ts";
import { DotEnvFallbackSecretStore } from "../src/secrets/environment.ts";
import { FileSecretStore } from "../src/secrets/store.ts";
import { createPortusQcHttpServer } from "../src/server.ts";

const SECRET_HEADERS = { "x-portus-qc-console-secret": "1" };

function json(method, body) {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function memorySettings(initial) {
  let value = initial;
  return {
    async load() { return value; },
    async save(next) { value = structuredClone(next); },
    async clear() { value = undefined; },
    async update(updater) {
      const next = updater(value === undefined ? undefined : structuredClone(value));
      value = next === undefined ? undefined : structuredClone(next);
      return value;
    },
    current() { return value; }
  };
}

async function start(t, service) {
  const { server } = createPortusQcHttpServer({ moondreamSettings: service, startedAt: "2026-08-28T00:00:00.000Z" });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${address.port}`;
}

test("Moondream Settings exposes the key only through the protected Console read and saves or clears both fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-moonda-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = new FileSecretStore(root);
  const config = { inference: { model: "fixture-default" } };
  const settingsRepository = memorySettings({ runtime: { port: 4321 } });
  const service = createMoondreamSettingsService({ secrets, config, settingsRepository, defaultModel: "fixture-default" });
  const url = await start(t, service);

  const initial = await fetch(`${url}/api/inference/moondream`);
  assert.equal(initial.status, 200);
  assert.deepEqual((await initial.json()).moondream, { configured: false, model: "fixture-default" });

  const unprotectedKey = await fetch(`${url}/api/inference/moondream/key`);
  assert.equal(unprotectedKey.status, 403);
  assert.equal((await unprotectedKey.json()).error.code, "console_secret_request_required");

  const emptyKey = await fetch(`${url}/api/inference/moondream/key`, { headers: SECRET_HEADERS });
  assert.equal(emptyKey.status, 200);
  assert.deepEqual(await emptyKey.json(), { apiKey: "" });

  const secret = "user-provided-secret";
  const saved = await fetch(`${url}/api/inference/moondream`, json("PUT", { model: "moondream-custom", apiKey: secret }));
  const savedText = await saved.text();
  assert.equal(saved.status, 200);
  assert.equal(savedText.includes(secret), false);
  assert.deepEqual(JSON.parse(savedText).moondream, { configured: true, model: "moondream-custom" });
  assert.equal(config.inference.model, "moondream-custom");
  assert.deepEqual(settingsRepository.current(), { runtime: { port: 4321 }, inference: { model: "moondream-custom" } });

  const revealed = await fetch(`${url}/api/inference/moondream/key`, { headers: SECRET_HEADERS });
  assert.deepEqual(await revealed.json(), { apiKey: secret });

  const cleared = await fetch(`${url}/api/inference/moondream`, json("PUT", { model: "", apiKey: "" }));
  assert.equal(cleared.status, 200);
  assert.deepEqual((await cleared.json()).moondream, { configured: false, model: "fixture-default" });
  assert.equal(config.inference.model, "fixture-default");
  assert.deepEqual(settingsRepository.current(), { runtime: { port: 4321 } });
  assert.deepEqual(await (await fetch(`${url}/api/inference/moondream/key`, { headers: SECRET_HEADERS })).json(), { apiKey: "" });

  const removedTestRoute = await fetch(`${url}/api/inference/moondream/test`, { method: "POST" });
  assert.equal(removedTestRoute.status, 404);
});

test("clearing the GUI key removes the saved override and reveals the repository .env fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-moonda-dotenv-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backing = new FileSecretStore(root);
  const secrets = new DotEnvFallbackSecretStore(backing, { MOONDREAM_API_KEY: "dotenv-secret" });
  const config = { inference: { model: "fixture-default" } };
  const settingsRepository = memorySettings();
  const service = createMoondreamSettingsService({ secrets, config, settingsRepository, defaultModel: "fixture-default" });

  assert.deepEqual(await service.settings(), { configured: true, model: "fixture-default" });
  assert.equal(await service.apiKey(), "dotenv-secret");

  await service.save({ model: "custom-model", apiKey: "saved-secret" });
  assert.deepEqual(await service.settings(), { configured: true, model: "custom-model" });
  assert.equal(await service.apiKey(), "saved-secret");
  assert.deepEqual(settingsRepository.current(), { inference: { model: "custom-model" } });

  await service.save({ model: "", apiKey: "" });
  assert.deepEqual(await service.settings(), { configured: true, model: "fixture-default" });
  assert.equal(await service.apiKey(), "dotenv-secret");
  assert.equal(settingsRepository.current(), undefined);
});
