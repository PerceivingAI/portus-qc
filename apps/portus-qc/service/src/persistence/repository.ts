import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initialMigration } from "./migrations/001-initial";
import { inspectionsMigration } from "./migrations/002-inspections";
import { inspectionCapabilityMigration } from "./migrations/003-inspection-capability";
import { resultsMigration } from "./migrations/004-results";
import { resultArtifactIntegrityMigration } from "./migrations/005-result-artifact-integrity";
import { camerasMigration } from "./migrations/006-cameras";
import { cameraSlotsMigration } from "./migrations/007-camera-slots";
import { schedulesMigration } from "./migrations/008-schedules";
import { consoleSelectionReservedMigration } from "./migrations/009-console-selection-reserved";
import { scheduledTasksMigration } from "./migrations/010-scheduled-tasks";

interface Migration {
  readonly version: number;
  up(database: DatabaseSync): void;
}

const migrations: readonly Migration[] = [initialMigration, inspectionsMigration, inspectionCapabilityMigration, resultsMigration, resultArtifactIntegrityMigration, camerasMigration, cameraSlotsMigration, schedulesMigration, consoleSelectionReservedMigration, scheduledTasksMigration];

export interface StateRepository {
  readonly databasePath: string;
  readonly database: DatabaseSync;
  close(): void;
}

function applyMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const hasMigration = database.prepare("SELECT version FROM schema_migrations WHERE version = ?");
  const recordMigration = database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)");

  for (const migration of migrations) {
    if (hasMigration.get(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.up(database);
      recordMigration.run(migration.version, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

export async function openStateRepository(databasePath: string): Promise<StateRepository> {
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA synchronous = NORMAL;");
    applyMigrations(database);
  } catch (error) {
    database.close();
    throw error;
  }

  let closed = false;
  return {
    databasePath,
    database,
    close(): void {
      if (closed) return;
      closed = true;
      database.close();
    }
  };
}
