import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openLocalApplicationState } from "../src/local-state.ts";
import { initialMigration } from "../src/persistence/migrations/001-initial.ts";
import { inspectionsMigration } from "../src/persistence/migrations/002-inspections.ts";
import { inspectionCapabilityMigration } from "../src/persistence/migrations/003-inspection-capability.ts";
import { resultsMigration } from "../src/persistence/migrations/004-results.ts";
import { resultArtifactIntegrityMigration } from "../src/persistence/migrations/005-result-artifact-integrity.ts";
import { camerasMigration } from "../src/persistence/migrations/006-cameras.ts";
import { cameraSlotsMigration } from "../src/persistence/migrations/007-camera-slots.ts";
import { schedulesMigration } from "../src/persistence/migrations/008-schedules.ts";
import { openStateRepository } from "../src/persistence/repository.ts";
import { SqliteAppSettingsRepository } from "../src/persistence/settings.ts";

test("SQLite settings persist across reopen and migration state is recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-state-"));
  const databasePath = join(root, "state", "portus-qc.sqlite");
  try {
    let state = await openStateRepository(databasePath);
    let settings = new SqliteAppSettingsRepository(state);
    await settings.save({ runtime: { port: 4321 }, inference: { model: "saved-model" } });
    const migration = state.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    assert.deepEqual(migration.map((row) => Number(row.version)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(state.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'console_selection'").get(), undefined);
    state.close();

    state = await openStateRepository(databasePath);
    settings = new SqliteAppSettingsRepository(state);
    assert.deepEqual(await settings.load(), { runtime: { port: 4321 }, inference: { model: "saved-model" } });
    await assert.rejects(() => settings.save({ runtime: { dataRoot: "other-root" } }), /bootstrap setting/u);
    await assert.rejects(() => settings.save({ inference: { apiKey: "must-not-enter-sqlite" } }), /Secret field/u);
    state.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent application-setting updates merge atomically without losing other saved domains", async () => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-settings-atomic-"));
  const databasePath = join(root, "state.sqlite");
  try {
    const state = await openStateRepository(databasePath);
    const settings = new SqliteAppSettingsRepository(state);
    await settings.save({ runtime: { port: 4321 } });

    await Promise.all([
      settings.update((current) => ({ ...(current ?? {}), console: { selectedCameraId: "camera-two" } })),
      settings.update((current) => ({ ...(current ?? {}), inference: { ...(current?.inference ?? {}), model: "atomic-model" } })),
      settings.update((current) => ({ ...(current ?? {}), artifacts: { root: "/tmp/portus-qc-results" } }))
    ]);

    assert.deepEqual(await settings.load(), {
      runtime: { port: 4321 },
      console: { selectedCameraId: "camera-two" },
      inference: { model: "atomic-model" },
      artifacts: { root: "/tmp/portus-qc-results" }
    });
    state.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted decision-era media retention flags are ignored during settings compatibility load", async () => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-settings-media-compat-"));
  const databasePath = join(root, "state.sqlite");
  try {
    const state = await openStateRepository(databasePath);
    state.database.prepare("INSERT INTO app_settings(id, overrides_json, updated_at) VALUES (1, ?, ?)").run(
      JSON.stringify({ media: { retainPass: false, retainReview: true, retainFail: true, maxAgeDays: 7 } }),
      "2026-08-28T00:00:00.000Z"
    );
    const settings = new SqliteAppSettingsRepository(state);
    assert.deepEqual(await settings.load(), { media: { maxAgeDays: 7 } });
    state.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspection migration preserves S6 prompts and defaults legacy rows to Query", async () => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-inspection-migration-"));
  const databasePath = join(root, "state.sqlite");
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    initialMigration.up(legacy);
    inspectionsMigration.up(legacy);
    legacy.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, "2026-08-27T00:00:00.000Z");
    legacy.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(2, "2026-08-27T00:00:00.000Z");
    legacy.prepare(`
      INSERT INTO inspections(
        id, name, prompt, enabled, output_schema, output_version,
        pass_decision, review_decision, fail_decision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-apples",
      "Legacy apples",
      "Find blemishes on the apples.",
      1,
      "qc-v1",
      1,
      "PASS",
      "REVIEW",
      "FAIL",
      "2026-08-27T00:00:00.000Z",
      "2026-08-27T00:00:00.000Z"
    );
    legacy.close();

    const state = await openStateRepository(databasePath);
    const row = state.database.prepare("SELECT id, prompt, capability FROM inspections WHERE id = ?").get("legacy-apples");
    assert.equal(row.prompt, "Find blemishes on the apples.");
    assert.equal(row.capability, "query");
    const columns = state.database.prepare("PRAGMA table_info(inspections)").all().map((item) => String(item.name));
    assert.deepEqual(columns, ["id", "name", "prompt", "enabled", "capability", "created_at", "updated_at"]);
    assert.deepEqual(state.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((item) => Number(item.version)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    state.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schedule migration preserves v8 task meaning while removing shared-inspection coupling", async () => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-schedule-migration-"));
  const databasePath = join(root, "state.sqlite");
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const migrations = [
      initialMigration,
      inspectionsMigration,
      inspectionCapabilityMigration,
      resultsMigration,
      resultArtifactIntegrityMigration,
      camerasMigration,
      cameraSlotsMigration,
      schedulesMigration
    ];
    for (const migration of migrations) {
      migration.up(legacy);
      legacy.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, "2026-08-28T00:00:00.000Z");
    }
    // Reproduce real upgraded installations where the now-removed console-selection
    // migration had already claimed version 9 before scheduled tasks existed.
    legacy.exec(`
      CREATE TABLE console_selection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        camera_id TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(9, "2026-08-28T19:07:38.751Z");
    legacy.prepare(`
      INSERT INTO inspections(id, name, prompt, enabled, capability, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("console-inspection", "Console inspection", "Find blemishes.", 1, "detect", "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z");
    legacy.prepare(`
      INSERT INTO cameras(id, slot, alias, host, port, protocol, stream, path, transport, rtsp_client, rtsp_auth, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("camera-a", 1, "Receiving", "192.168.1.10", null, "rtsp", "stream1", null, "tcp", "gortsplib", "auto", "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z");
    legacy.prepare(`
      INSERT INTO schedules(id, camera_id, inspection_id, interval_ms, enabled, next_run_at, last_status, dropped_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("schedule-old", "camera-a", "console-inspection", 60_000, 1, "2026-08-28T00:01:00.000Z", "completed", 2, "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z");
    legacy.close();

    const state = await openStateRepository(databasePath);
    const row = state.database.prepare("SELECT id, camera_id, prompt, capability, interval_ms, enabled, next_run_at, last_status, dropped_count FROM schedules WHERE id = ?").get("schedule-old");
    assert.equal(row.camera_id, "camera-a");
    assert.equal(row.prompt, "Find blemishes.");
    assert.equal(row.capability, "detect");
    assert.equal(row.interval_ms, 60_000);
    assert.equal(row.enabled, 1);
    assert.equal(row.next_run_at, "2026-08-28T00:01:00.000Z");
    assert.equal(row.last_status, "completed");
    assert.equal(row.dropped_count, 2);
    const columns = state.database.prepare("PRAGMA table_info(schedules)").all().map((item) => String(item.name));
    assert.equal(columns.includes("inspection_id"), false);
    assert.ok(columns.includes("prompt"));
    assert.ok(columns.includes("capability"));
    assert.equal(state.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'console_selection'").get(), undefined);
    assert.deepEqual(state.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((item) => Number(item.version)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    state.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local application state loads persisted settings before service use and keeps secrets outside SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-local-state-"));
  const secretValue = "local-test-moony-secret-123456789";
  try {
    let local = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
    assert.equal(local.paths.dataRoot, root);
    assert.equal(local.config.runtime.port, 3210);
    await local.settings.save({ runtime: { port: 4123 } });
    await local.secrets.set("moondream:api-key", secretValue);
    local.close();

    local = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
    assert.equal(local.config.runtime.port, 4123);
    assert.equal(await local.secrets.get("moondream:api-key"), secretValue);
    local.close();

    const sqliteBytes = await readFile(join(root, "state", "portus-qc.sqlite"));
    assert.equal(sqliteBytes.toString("utf8").includes(secretValue), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
