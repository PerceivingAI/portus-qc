import type { DatabaseSync } from "node:sqlite";

export const inspectionsMigration = {
  version: 2,
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE inspections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        output_schema TEXT NOT NULL CHECK (output_schema = 'qc-v1'),
        output_version INTEGER NOT NULL CHECK (output_version = 1),
        pass_decision TEXT NOT NULL CHECK (pass_decision = 'PASS'),
        review_decision TEXT NOT NULL CHECK (review_decision = 'REVIEW'),
        fail_decision TEXT NOT NULL CHECK (fail_decision = 'FAIL'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX inspections_enabled_name_idx ON inspections(enabled, name COLLATE NOCASE, id);
    `);
  }
} as const;
