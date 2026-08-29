import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createPortusQcHttpServer } from "../src/server.ts";

async function start(t) {
  let root = process.cwd();
  const artifacts = {
    settings: () => ({ root, configuredRoot: root }),
    setRoot: async (value) => {
      root = value ?? process.cwd();
      return { root, configuredRoot: value };
    },
    pickRoot: async () => {
      root = process.cwd();
      return { selected: true, settings: { root, configuredRoot: root } };
    },
    exportResult: async (id) => ({ absolutePath: `${root}/${id}.txt`, mimeType: "text/plain" })
  };
  const { server } = createPortusQcHttpServer({ artifacts, startedAt: "2026-08-27T00:00:00.000Z" });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${address.port}`;
}

test("artifact HTTP routes expose settings, native-picker action, and result re-export without browser filesystem authority", async (t) => {
  const url = await start(t);
  const settings = await fetch(`${url}/api/artifacts/settings`);
  assert.equal(settings.status, 200);
  assert.equal(typeof (await settings.json()).artifacts.root, "string");

  const custom = process.cwd();
  const update = await fetch(`${url}/api/artifacts/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: custom })
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).artifacts.root, custom);

  const blocked = await fetch(`${url}/api/artifacts/pick-folder`, { method: "POST", headers: { origin: "https://example.invalid" } });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, "cross_origin_forbidden");

  const sameOrigin = await fetch(`${url}/api/artifacts/pick-folder`, { method: "POST", headers: { origin: url } });
  assert.equal(sameOrigin.status, 200);

  const picked = await fetch(`${url}/api/artifacts/pick-folder`, { method: "POST" });
  assert.equal(picked.status, 200);
  assert.equal((await picked.json()).selected, true);

  const exported = await fetch(`${url}/api/artifacts/export/result-1`, { method: "POST" });
  assert.equal(exported.status, 200);
  assert.match((await exported.json()).artifact.absolutePath, /result-1\.txt$/u);

  const wrongMethod = await fetch(`${url}/api/artifacts/pick-folder`);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
});
