import type { DatabaseSync } from "node:sqlite";

export const initialMigration = {
  version: 1,
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        overrides_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
} as const;
