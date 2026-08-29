import type { DatabaseSync } from "node:sqlite";

export const inspectionCapabilityMigration = {
  version: 3,
  up(database: DatabaseSync): void {
    database.exec(`
      ALTER TABLE inspections RENAME TO inspections_v2;
      DROP INDEX IF EXISTS inspections_enabled_name_idx;

      CREATE TABLE inspections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        capability TEXT NOT NULL CHECK (capability IN ('query', 'detect', 'segment', 'point', 'caption')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO inspections(id, name, prompt, enabled, capability, created_at, updated_at)
      SELECT id, name, prompt, enabled, 'query', created_at, updated_at
      FROM inspections_v2;

      DROP TABLE inspections_v2;
      CREATE INDEX inspections_enabled_name_idx ON inspections(enabled, name COLLATE NOCASE, id);
    `);
  }
} as const;
