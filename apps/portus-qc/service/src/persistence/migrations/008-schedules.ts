import type { DatabaseSync } from "node:sqlite";

export const schedulesMigration = {
  version: 8,
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
        inspection_id TEXT NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
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
        updated_at TEXT NOT NULL,
        UNIQUE(camera_id, inspection_id)
      );

      CREATE INDEX schedules_enabled_next_idx ON schedules(enabled, next_run_at);
      CREATE INDEX schedules_camera_idx ON schedules(camera_id);
      CREATE INDEX schedules_inspection_idx ON schedules(inspection_id);
    `);
  }
} as const;
