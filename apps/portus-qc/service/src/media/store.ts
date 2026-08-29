import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type MediaKind = "capture" | "frame" | "clip";
export type SupportedMediaMimeType = "image/jpeg" | "image/png" | "image/webp" | "video/mp4";

export interface SaveMediaInput {
  id: string;
  kind: MediaKind;
  bytes: Uint8Array;
  mimeType: SupportedMediaMimeType;
  createdAt?: string;
}

export interface StoredMedia {
  id: string;
  kind: MediaKind;
  mimeType: SupportedMediaMimeType;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  createdAt: string;
}

export interface MediaStore {
  readonly root: string;
  save(input: SaveMediaInput): Promise<StoredMedia>;
  read(relativePath: string): Promise<Uint8Array>;
  delete(relativePath: string): Promise<void>;
}

const EXTENSIONS: Record<SupportedMediaMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4"
};

const MIME_BY_EXTENSION = new Map<string, SupportedMediaMimeType>([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["mp4", "video/mp4"]
]);

export function mediaMimeTypeForPath(relativePath: string): SupportedMediaMimeType | undefined {
  const filename = relativePath.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const extension = filename.includes(".") ? filename.split(".").at(-1)?.toLowerCase() : undefined;
  return extension ? MIME_BY_EXTENSION.get(extension) : undefined;
}

function checkedCreatedAt(value: string | undefined): { text: string; date: Date } {
  const text = value ?? new Date().toISOString();
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error("Media createdAt must be a valid timestamp.");
  return { text, date };
}

function safeId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Media id must not be empty.");
  return trimmed.replace(/[^a-zA-Z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64) || "media";
}

function portableRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

function containedPath(root: string, requested: string): string {
  if (!requested.trim() || isAbsolute(requested)) throw new Error("Media path must be a non-empty relative path.");
  const absolute = resolve(root, requested);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Media path escapes the configured media root.");
  return absolute;
}

export class FileSystemMediaStore implements MediaStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async save(input: SaveMediaInput): Promise<StoredMedia> {
    if (input.bytes.byteLength === 0) throw new Error("Media bytes must not be empty.");
    if (input.kind !== "capture" && input.kind !== "frame" && input.kind !== "clip") throw new Error(`Unsupported media kind: ${String(input.kind)}.`);
    const extension = EXTENSIONS[input.mimeType];
    if (!extension) throw new Error(`Unsupported media MIME type: ${String(input.mimeType)}.`);
    const created = checkedCreatedAt(input.createdAt);
    const dateDirectory = created.text.slice(0, 10);
    const hash = createHash("sha256").update(input.id).update("\0").update(created.text).digest("hex").slice(0, 12);
    const filename = `${safeId(input.id)}-${hash}.${extension}`;
    const absolutePath = join(this.root, dateDirectory, input.kind, filename);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    const temporary = `${absolutePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
      try {
        await rename(temporary, absolutePath);
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || (error.code !== "EEXIST" && error.code !== "EPERM")) throw error;
        await rm(absolutePath, { force: true });
        await rename(temporary, absolutePath);
      }
      await utimes(absolutePath, created.date, created.date);
    } finally {
      await rm(temporary, { force: true });
    }
    const info = await stat(absolutePath);
    return {
      id: input.id,
      kind: input.kind,
      mimeType: input.mimeType,
      relativePath: portableRelative(this.root, absolutePath),
      absolutePath,
      sizeBytes: info.size,
      createdAt: created.text
    };
  }

  async read(relativePath: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(containedPath(this.root, relativePath)));
  }

  async delete(relativePath: string): Promise<void> {
    await rm(containedPath(this.root, relativePath), { force: true });
  }
}
