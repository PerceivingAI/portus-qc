import type { DatabaseSync } from "node:sqlite";

export const scheduledTasksMigration = {
  version: 10,
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE schedules_v2 (
        id TEXT PRIMARY KEY,
        camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
        capability TEXT NOT NULL CHECK (capability IN ('query', 'detect', 'segment', 'point', 'caption')),
        interval_ms INTEGER NOT NULL CHECK (interval_ms > 0),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        next_run_at TEXT,
        last_run_at TEXT,
        last_finished_at TEXT,
        last_status TEXT CHECK (last_status IS NULL OR last_status IN ('completed', 'failed', 'dropped')),
        last_result_id TEXT,
        last_error TEXT,
        dropped_count INTEGER NOT NULL DEFAULT 0 CHECK (dropped_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO schedules_v2(
        id, camera_id, prompt, capability, interval_ms, enabled, next_run_at,
        last_run_at, last_finished_at, last_status, last_result_id, last_error,
        dropped_count, created_at, updated_at
      )
      SELECT
        schedules.id,
        schedules.camera_id,
        inspections.prompt,
        inspections.capability,
        schedules.interval_ms,
        schedules.enabled,
        schedules.next_run_at,
        schedules.last_run_at,
        schedules.last_finished_at,
        schedules.last_status,
        schedules.last_result_id,
        schedules.last_error,
        schedules.dropped_count,
        schedules.created_at,
        schedules.updated_at
      FROM schedules
      JOIN inspections ON inspections.id = schedules.inspection_id;

      DROP TABLE schedules;
      ALTER TABLE schedules_v2 RENAME TO schedules;
      DROP TABLE IF EXISTS console_selection;

      CREATE INDEX schedules_enabled_next_idx ON schedules(enabled, next_run_at);
      CREATE INDEX schedules_camera_idx ON schedules(camera_id);
    `);
  }
} as const;
