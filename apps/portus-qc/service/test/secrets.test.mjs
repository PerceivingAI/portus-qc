import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DotEnvFallbackSecretStore } from "../src/secrets/environment.ts";
import { FileSecretStore, secretKeys } from "../src/secrets/store.ts";

test("file secret store persists, replaces, and deletes values without using secret names as filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-secrets-"));
  try {
    const store = new FileSecretStore(root);
    const key = secretKeys.moondreamApiKey;
    assert.equal(await store.has(key), false);
    await store.set(key, "first-secret");
    assert.equal(await store.has(key), true);
    assert.equal(await store.get(key), "first-secret");
    assert.equal(await store.source(key), "persistent");

    const names = await readdir(root);
    assert.equal(names.length, 1);
    assert.match(names[0], /^[a-f0-9]{64}\.secret$/u);
    assert.equal(names[0].includes("moondream"), false);

    await store.set(key, "replacement-secret");
    assert.equal(await store.get(key), "replacement-secret");
    await store.delete(key);
    assert.equal(await store.get(key), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file secret store does not disguise corrupt storage entries as missing secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-secrets-corrupt-"));
  try {
    const store = new FileSecretStore(root);
    const key = secretKeys.moondreamApiKey;
    await store.set(key, "secret");
    const [filename] = await readdir(root);
    assert.ok(filename);
    await rm(join(root, filename), { force: true });
    await mkdir(join(root, filename));
    await assert.rejects(() => store.has(key), /not a regular file/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saved Moondream key has priority over repository .env fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-dotenv-secrets-"));
  try {
    const backing = new FileSecretStore(root);
    const store = new DotEnvFallbackSecretStore(backing, { MOONDREAM_API_KEY: "dotenv-secret" });
    assert.equal(await store.has(secretKeys.moondreamApiKey), true);
    assert.equal(await store.get(secretKeys.moondreamApiKey), "dotenv-secret");
    assert.equal(await store.source(secretKeys.moondreamApiKey), "dotenv");
    assert.deepEqual(await readdir(root), []);

    await store.set(secretKeys.moondreamApiKey, "saved-secret");
    assert.equal(await store.get(secretKeys.moondreamApiKey), "saved-secret");
    assert.equal(await store.source(secretKeys.moondreamApiKey), "persistent");
    await store.delete(secretKeys.moondreamApiKey);
    assert.equal(await store.get(secretKeys.moondreamApiKey), "dotenv-secret");
    assert.equal(await store.source(secretKeys.moondreamApiKey), "dotenv");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("camera secret keys remain caller-facing identifiers while storage filenames stay opaque", () => {
  assert.equal(secretKeys.cameraUsername("line-a"), "camera:line-a:username");
  assert.equal(secretKeys.cameraPassword("line-a"), "camera:line-a:password");
});
