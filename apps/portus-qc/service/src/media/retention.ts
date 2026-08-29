import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MediaConfig } from "../../../config/schema";

export interface MediaRetentionPolicy {
  maxAgeDays: number;
  maxFiles: number;
  maxBytes: number;
}

export interface MediaRetentionResult {
  deletedFiles: number;
  deletedBytes: number;
  remainingFiles: number;
  remainingBytes: number;
}

interface MediaFileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

export function mediaRetentionPolicy(config: MediaConfig): MediaRetentionPolicy {
  return {
    maxAgeDays: config.maxAgeDays,
    maxFiles: config.maxFiles,
    maxBytes: config.maxBytes
  };
}

async function collectFiles(root: string): Promise<MediaFileInfo[]> {
  const files: MediaFileInfo[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }
  await walk(root);
  return files;
}

export async function enforceMediaRetention(
  root: string,
  policy: MediaRetentionPolicy,
  now = new Date(),
  protectedRelativePaths: readonly string[] = []
): Promise<MediaRetentionResult> {
  const cutoff = now.getTime() - policy.maxAgeDays * 86_400_000;
  const protectedPaths = new Set(protectedRelativePaths.map((item) => join(root, ...item.replace(/\\/gu, "/").split("/"))));
  const files = (await collectFiles(root)).sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  let remainingFiles = files.length;
  let remainingBytes = files.reduce((total, file) => total + file.size, 0);
  let deletedFiles = 0;
  let deletedBytes = 0;

  for (const file of files) {
    if (protectedPaths.has(file.path)) continue;
    const tooOld = file.mtimeMs < cutoff;
    const tooMany = remainingFiles > policy.maxFiles;
    const tooLarge = remainingBytes > policy.maxBytes;
    if (!tooOld && !tooMany && !tooLarge) continue;
    await rm(file.path, { force: true });
    remainingFiles -= 1;
    remainingBytes -= file.size;
    deletedFiles += 1;
    deletedBytes += file.size;
  }

  return { deletedFiles, deletedBytes, remainingFiles, remainingBytes };
}
