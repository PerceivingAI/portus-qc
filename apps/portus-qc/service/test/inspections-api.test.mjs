import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInspectionService } from "../src/domain/inspections.ts";
import { openLocalApplicationState } from "../src/local-state.ts";
import { SqliteInspectionRepository } from "../src/persistence/inspections.ts";
import { createPortusQcHttpServer } from "../src/server.ts";

async function startInspectionApi(t) {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-inspection-api-"));
  const state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  const inspections = createInspectionService(new SqliteInspectionRepository(state.stateRepository));
  const { server } = createPortusQcHttpServer({ inspections, startedAt: "2026-08-27T00:00:00.000Z" });
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

function jsonRequest(method, body) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

test("inspection HTTP CRUD exposes prompt plus one selected capability", async (t) => {
  const url = await startInspectionApi(t);

  const create = await fetch(`${url}/api/inspections`, jsonRequest("POST", {
    id: "dented-cans",
    name: "Dented cans",
    prompt: "Look for visible dents on cans.",
    capability: "detect"
  }));
  assert.equal(create.status, 201);
  assert.equal(create.headers.get("location"), "/api/inspections/dented-cans");
  const created = (await create.json()).inspection;
  assert.deepEqual(created, {
    id: "dented-cans",
    name: "Dented cans",
    prompt: "Look for visible dents on cans.",
    enabled: true,
    capability: "detect"
  });

  const duplicate = await fetch(`${url}/api/inspections`, jsonRequest("POST", {
    id: "dented-cans",
    name: "Duplicate",
    prompt: "Must conflict."
  }));
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "inspection_conflict");

  const list = await fetch(`${url}/api/inspections`);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).inspections.map((item) => item.id), ["dented-cans"]);

  const get = await fetch(`${url}/api/inspections/dented-cans`);
  assert.equal(get.status, 200);
  assert.equal((await get.json()).inspection.capability, "detect");

  const replace = await fetch(`${url}/api/inspections/dented-cans`, jsonRequest("PUT", {
    name: "Can dent check",
    prompt: "Check cans for dents and deformation.",
    enabled: false,
    capability: "segment"
  }));
  assert.equal(replace.status, 200);
  const replaced = (await replace.json()).inspection;
  assert.equal(replaced.enabled, false);
  assert.equal(replaced.capability, "segment");

  const deletion = await fetch(`${url}/api/inspections/dented-cans`, { method: "DELETE" });
  assert.equal(deletion.status, 204);
  assert.equal(await deletion.text(), "");
  assert.equal((await fetch(`${url}/api/inspections/dented-cans`)).status, 404);
});

test("inspection HTTP routes reject invalid capability and decision-era payloads", async (t) => {
  const url = await startInspectionApi(t);
  const invalid = await fetch(`${url}/api/inspections`, jsonRequest("POST", {
    id: "bad-capability",
    name: "Bad capability",
    prompt: "Check something.",
    capability: "classify"
  }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "inspection_invalid");

  const legacy = await fetch(`${url}/api/inspections`, jsonRequest("POST", {
    id: "legacy-map",
    name: "Legacy mapping",
    prompt: "Check something.",
    decisionMapping: { pass: "PASS", review: "REVIEW", fail: "FAIL" }
  }));
  assert.equal(legacy.status, 400);
  assert.equal((await legacy.json()).error.code, "inspection_invalid");

  const wrongType = await fetch(`${url}/api/inspections`, { method: "POST", body: "{}" });
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).error.code, "unsupported_media_type");

  const wrongMethod = await fetch(`${url}/api/inspections`, { method: "PATCH" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET, POST");
});
