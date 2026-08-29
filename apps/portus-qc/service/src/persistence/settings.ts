import type { AppConfigOverrides } from "../../../config/schema";
import type { StateRepository } from "./repository";

const ROOT_KEYS = new Set(["runtime", "inference", "camera", "console", "scheduler", "video", "media", "artifacts"]);
const FORBIDDEN_SECRET_KEYS = new Set(["apikey", "api_key", "password", "secret", "token", "credential", "credentials", "moondreamapikey"]);

export type AppSettingsUpdater = (current: AppConfigOverrides | undefined) => AppConfigOverrides | undefined;

export interface AppSettingsRepository {
  load(): Promise<AppConfigOverrides | undefined>;
  save(overrides: AppConfigOverrides): Promise<void>;
  clear(): Promise<void>;
  update(updater: AppSettingsUpdater): Promise<AppConfigOverrides | undefined>;
}

function parseOverridesJson(serialized: string): AppConfigOverrides {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Persisted application settings contain invalid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Persisted application settings must be an object.");
  const record = structuredClone(value) as Record<string, unknown>;
  const media = record.media;
  if (media && typeof media === "object" && !Array.isArray(media)) {
    const legacy = media as Record<string, unknown>;
    delete legacy.retainPass;
    delete legacy.retainReview;
    delete legacy.retainFail;
  }
  const extraRootKeys = Object.keys(record).filter((key) => !ROOT_KEYS.has(key));
  if (extraRootKeys.length) throw new Error(`Persisted application settings contain unsupported field(s): ${extraRootKeys.join(", ")}.`);
  for (const [domain, domainValue] of Object.entries(record)) {
    if (domainValue === undefined) continue;
    if (domainValue === null || typeof domainValue !== "object" || Array.isArray(domainValue)) throw new Error(`Persisted application settings ${domain} must be an object.`);
  }
  assertNoSecrets(record);
  const runtime = record.runtime as Record<string, unknown> | undefined;
  if (runtime && Object.hasOwn(runtime, "dataRoot")) throw new Error("runtime.dataRoot is a bootstrap setting and cannot be persisted inside the database it selects.");
  return record as AppConfigOverrides;
}

function assertNoSecrets(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) throw new Error(`Secret field ${key} cannot be stored in ordinary application settings.`);
    assertNoSecrets(child);
  }
}

function serializedOverrides(overrides: AppConfigOverrides): string {
  const copy = structuredClone(overrides) as Record<string, unknown>;
  const runtime = copy.runtime as Record<string, unknown> | undefined;
  if (runtime && Object.hasOwn(runtime, "dataRoot")) throw new Error("runtime.dataRoot is a bootstrap setting and cannot be persisted inside the database it selects.");
  assertNoSecrets(copy);
  return JSON.stringify(copy);
}

function currentOverrides(state: StateRepository): AppConfigOverrides | undefined {
  const row = state.database.prepare("SELECT overrides_json FROM app_settings WHERE id = 1").get() as { overrides_json?: unknown } | undefined;
  if (!row) return undefined;
  if (typeof row.overrides_json !== "string") throw new Error("Persisted application settings are unreadable.");
  return parseOverridesJson(row.overrides_json);
}

function writeOverrides(state: StateRepository, overrides: AppConfigOverrides | undefined): void {
  if (overrides === undefined || Object.keys(overrides).length === 0) {
    state.database.prepare("DELETE FROM app_settings WHERE id = 1").run();
    return;
  }
  const serialized = serializedOverrides(overrides);
  state.database.prepare(`
    INSERT INTO app_settings(id, overrides_json, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET overrides_json = excluded.overrides_json, updated_at = excluded.updated_at
  `).run(serialized, new Date().toISOString());
}

export class SqliteAppSettingsRepository implements AppSettingsRepository {
  readonly #state: StateRepository;

  constructor(state: StateRepository) {
    this.#state = state;
  }

  async load(): Promise<AppConfigOverrides | undefined> {
    return currentOverrides(this.#state);
  }

  async save(overrides: AppConfigOverrides): Promise<void> {
    writeOverrides(this.#state, overrides);
  }

  async clear(): Promise<void> {
    writeOverrides(this.#state, undefined);
  }

  async update(updater: AppSettingsUpdater): Promise<AppConfigOverrides | undefined> {
    const database = this.#state.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const previous = currentOverrides(this.#state);
      const next = updater(previous === undefined ? undefined : structuredClone(previous));
      writeOverrides(this.#state, next);
      database.exec("COMMIT");
      return next === undefined ? undefined : structuredClone(next);
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
  }
}
