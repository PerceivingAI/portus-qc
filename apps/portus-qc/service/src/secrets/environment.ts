import type { SecretSource, SecretStore } from "./store";
import { secretKeys } from "./store";

/**
 * Saved GUI secrets are authoritative. The repository root .env is only a fallback
 * for the Moondream API key and is never copied into persistent secret storage.
 */
export class DotEnvFallbackSecretStore implements SecretStore {
  readonly #backing: SecretStore;
  readonly #moondreamApiKey: string | undefined;

  constructor(backing: SecretStore, dotenv: NodeJS.ProcessEnv) {
    this.#backing = backing;
    const apiKey = dotenv.MOONDREAM_API_KEY?.trim();
    this.#moondreamApiKey = apiKey || undefined;
  }

  async has(key: string): Promise<boolean> {
    if (await this.#backing.has(key)) return true;
    return key === secretKeys.moondreamApiKey && this.#moondreamApiKey !== undefined;
  }

  async get(key: string): Promise<string | undefined> {
    const saved = await this.#backing.get(key);
    if (saved !== undefined) return saved;
    if (key === secretKeys.moondreamApiKey) return this.#moondreamApiKey;
    return undefined;
  }

  async source(key: string): Promise<SecretSource | undefined> {
    if (await this.#backing.has(key)) return this.#backing.source ? this.#backing.source(key) : "persistent";
    if (key === secretKeys.moondreamApiKey && this.#moondreamApiKey !== undefined) return "dotenv";
    return undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.#backing.set(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.#backing.delete(key);
  }
}
