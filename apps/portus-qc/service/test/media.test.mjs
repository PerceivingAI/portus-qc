import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enforceMediaRetention, mediaRetentionPolicy } from "../src/media/retention.ts";
import { FileSystemMediaStore } from "../src/media/store.ts";

const bytes = (length, value = 7) => new Uint8Array(length).fill(value);

test("filesystem media store owns deterministic contained paths and round-trips bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-media-"));
  try {
    const store = new FileSystemMediaStore(root);
    const saved = await store.save({ id: "camera:one/snapshot", kind: "capture", bytes: bytes(12), mimeType: "image/jpeg", createdAt: "2026-08-27T12:00:00.000Z" });
    assert.equal(saved.relativePath.startsWith("2026-08-27/capture/"), true);
    assert.equal(saved.relativePath.includes(".."), false);
    assert.deepEqual(await store.read(saved.relativePath), bytes(12));
    await assert.rejects(() => store.read("../secrets/key.secret"), /escapes/u);
    await assert.rejects(() => store.save({ id: "bad", kind: "capture", bytes: bytes(1), mimeType: "application/octet-stream" }), /Unsupported media MIME/u);
    await store.delete(saved.relativePath);
    await assert.rejects(() => store.read(saved.relativePath), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("media retention is capability-neutral and enforces age/count/size limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-retention-"));
  try {
    const store = new FileSystemMediaStore(root);
    const policy = mediaRetentionPolicy({ schemaVersion: 1, root: null, maxAgeDays: 3, maxFiles: 2, maxBytes: 20 });

    await store.save({ id: "old", kind: "capture", bytes: bytes(8, 1), mimeType: "image/jpeg", createdAt: "2026-08-20T12:00:00.000Z" });
    await store.save({ id: "new-a", kind: "capture", bytes: bytes(8, 2), mimeType: "image/jpeg", createdAt: "2026-08-26T12:00:00.000Z" });
    await store.save({ id: "new-b", kind: "frame", bytes: bytes(8, 3), mimeType: "image/png", createdAt: "2026-08-27T12:00:00.000Z" });
    await store.save({ id: "new-c", kind: "clip", bytes: bytes(8, 4), mimeType: "video/mp4", createdAt: "2026-08-27T13:00:00.000Z" });

    const protectedMedia = await store.save({ id: "protected", kind: "capture", bytes: bytes(8, 5), mimeType: "image/jpeg", createdAt: "2026-08-20T11:00:00.000Z" });
    const result = await enforceMediaRetention(root, policy, new Date("2026-08-27T14:00:00.000Z"), [protectedMedia.relativePath]);
    assert.equal(result.deletedFiles, 3);
    assert.equal(result.deletedBytes, 24);
    assert.equal(result.remainingFiles, 2);
    assert.equal(result.remainingBytes, 16);
    assert.deepEqual(await store.read(protectedMedia.relativePath), bytes(8, 5));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
