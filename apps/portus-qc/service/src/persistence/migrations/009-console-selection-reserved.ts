import type { DatabaseSync } from "node:sqlite";

/**
 * Migration version 9 was briefly used by the removed console_selection table.
 * Existing local databases may already record version 9, so the number must
 * remain reserved forever. Fresh databases record the tombstone without
 * recreating the obsolete table.
 */
export const consoleSelectionReservedMigration = {
  version: 9,
  up(_database: DatabaseSync): void {
    // Historical tombstone. Camera selection now lives in app_settings.
  }
} as const;
