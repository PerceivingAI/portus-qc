import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverDownloadsDirectory } from "../src/runtime/user-folders.ts";

test("Linux Downloads discovery honors XDG user-dirs and falls back to the home Downloads folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-user-folders-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const portableRoot = root.replace(/\\/gu, "/");
  const home = "/home/tester";
  const config = `${portableRoot}/config`;
  await mkdir(config, { recursive: true });
  await writeFile(`${config}/user-dirs.dirs`, 'XDG_DOWNLOAD_DIR="$HOME/Shared Downloads"\n', "utf8");

  assert.equal(
    await discoverDownloadsDirectory({ platform: "linux", homeDirectory: home, environment: { XDG_CONFIG_HOME: config } }),
    `${home}/Shared Downloads`
  );
  assert.equal(
    await discoverDownloadsDirectory({ platform: "linux", homeDirectory: home, environment: { XDG_CONFIG_HOME: `${config}/missing` } }),
    `${home}/Downloads`
  );
});
