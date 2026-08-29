import type { AppConfig, AppConfigOverrides } from "../../../config/schema";
import type { AppSettingsRepository } from "../persistence/settings";
import { secretKeys, type SecretStore } from "../secrets/store";

export interface MoondreamSettingsView {
  configured: boolean;
  model: string;
}

export interface MoondreamSettingsUpdate {
  model: string;
  apiKey: string;
}

export type MoondreamSettingsErrorCode = "invalid_key" | "invalid_model";

export class MoondreamSettingsError extends Error {
  constructor(readonly code: MoondreamSettingsErrorCode, message: string) {
    super(message);
    this.name = "MoondreamSettingsError";
  }
}

export interface MoondreamSettingsService {
  settings(): Promise<MoondreamSettingsView>;
  apiKey(): Promise<string>;
  save(update: MoondreamSettingsUpdate): Promise<MoondreamSettingsView>;
}

function normalizedApiKey(value: string): string | undefined {
  if (typeof value !== "string") throw new MoondreamSettingsError("invalid_key", "Moondream API key must be a string.");
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > 4096) throw new MoondreamSettingsError("invalid_key", "Moondream API key must be at most 4096 characters.");
  return normalized;
}

function normalizedModel(value: string): string | undefined {
  if (typeof value !== "string") throw new MoondreamSettingsError("invalid_model", "Moondream model must be a string.");
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > 200) throw new MoondreamSettingsError("invalid_model", "Moondream model must be at most 200 characters.");
  return normalized;
}

function requiredDefaultModel(value: string): string {
  const normalized = normalizedModel(value);
  if (!normalized) throw new MoondreamSettingsError("invalid_model", "Default Moondream model must be configured.");
  return normalized;
}

function settingsWithModel(existing: AppConfigOverrides | undefined, model: string | undefined): AppConfigOverrides {
  const next = structuredClone(existing ?? {});
  const inference = { ...(next.inference ?? {}) };
  if (model === undefined) delete inference.model;
  else inference.model = model;
  if (Object.keys(inference).length === 0) delete next.inference;
  else next.inference = inference;
  return next;
}

export function createMoondreamSettingsService(input: {
  secrets: SecretStore;
  config: AppConfig;
  settingsRepository: AppSettingsRepository;
  defaultModel: string;
}): MoondreamSettingsService {
  const defaultModel = requiredDefaultModel(input.defaultModel);

  async function apiKey(): Promise<string> {
    return (await input.secrets.get(secretKeys.moondreamApiKey)) ?? "";
  }

  async function view(): Promise<MoondreamSettingsView> {
    return {
      configured: (await apiKey()).length > 0,
      model: input.config.inference.model
    };
  }

  return {
    settings: view,
    apiKey,

    async save(update: MoondreamSettingsUpdate): Promise<MoondreamSettingsView> {
      const model = normalizedModel(update.model);
      const key = normalizedApiKey(update.apiKey);
      const previousModel = input.config.inference.model;
      const previousSource = await input.secrets.source?.(secretKeys.moondreamApiKey);
      const previousSavedKey = previousSource === "persistent"
        ? await input.secrets.get(secretKeys.moondreamApiKey)
        : undefined;
      let previousPersistedModel: string | undefined;
      let settingsChanged = false;

      try {
        if (key === undefined) await input.secrets.delete(secretKeys.moondreamApiKey);
        else await input.secrets.set(secretKeys.moondreamApiKey, key);
        await input.settingsRepository.update((current) => {
          previousPersistedModel = current?.inference?.model;
          const next = settingsWithModel(current, model);
          return Object.keys(next).length === 0 ? undefined : next;
        });
        settingsChanged = true;
        input.config.inference.model = model ?? defaultModel;
        return await view();
      } catch (error) {
        try {
          if (previousSavedKey === undefined) await input.secrets.delete(secretKeys.moondreamApiKey);
          else await input.secrets.set(secretKeys.moondreamApiKey, previousSavedKey);
          if (settingsChanged) {
            await input.settingsRepository.update((current) => {
              const currentPersistedModel = current?.inference?.model;
              if (currentPersistedModel !== model) return current;
              const restored = settingsWithModel(current, previousPersistedModel);
              return Object.keys(restored).length === 0 ? undefined : restored;
            });
          }
          input.config.inference.model = previousModel;
        } catch {
          input.config.inference.model = previousModel;
        }
        throw error;
      }
    }
  };
}
