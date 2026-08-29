import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SecretSource = "dotenv" | "persistent";

export interface SecretStore {
  has(key: string): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  source?(key: string): Promise<SecretSource | undefined>;
}

export const secretKeys = {
  moondreamApiKey: "moondream:api-key",
  cameraUsername(cameraId: string): string { return `camera:${cameraId}:username`; },
  cameraPassword(cameraId: string): string { return `camera:${cameraId}:password`; }
} as const;

function checkedKey(key: string): string {
  const normalized = key.trim();
  if (!normalized || normalized.length > 512) throw new Error("Secret key must be a non-empty string up to 512 characters.");
  return normalized;
}

function secretFilename(key: string): string {
  return `${createHash("sha256").update(checkedKey(key)).digest("hex")}.secret`;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try { await chmod(path, 0o700); } catch { /* Best effort on platforms without POSIX permissions. */ }
}

export class FileSecretStore implements SecretStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async has(key: string): Promise<boolean> {
    await privateDirectory(this.#root);
    try {
      const info = await stat(join(this.#root, secretFilename(key)));
      if (!info.isFile()) throw new Error("Secret storage entry is not a regular file.");
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async get(key: string): Promise<string | undefined> {
    await privateDirectory(this.#root);
    try {
      return await readFile(join(this.#root, secretFilename(key)), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async source(key: string): Promise<SecretSource | undefined> {
    return await this.has(key) ? "persistent" : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    checkedKey(key);
    if (!value) throw new Error("Secret value must not be empty.");
    await privateDirectory(this.#root);
    const target = join(this.#root, secretFilename(key));
    const temporary = join(this.#root, `.${secretFilename(key)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        await rename(temporary, target);
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || (error.code !== "EEXIST" && error.code !== "EPERM")) throw error;
        await rm(target, { force: true });
        await rename(temporary, target);
      }
      try { await chmod(target, 0o600); } catch { /* Best effort on platforms without POSIX permissions. */ }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async delete(key: string): Promise<void> {
    await rm(join(this.#root, secretFilename(key)), { force: true });
  }
}
