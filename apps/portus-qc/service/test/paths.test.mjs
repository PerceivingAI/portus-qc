import assert from "node:assert/strict";
import test from "node:test";
import { loadRepositoryDefaults } from "../../config/defaults.ts";
import { resolveAppPaths } from "../src/persistence/paths.ts";

test("default application paths are deterministic by platform and media defaults stay under data root", async () => {
  const config = await loadRepositoryDefaults();
  const windows = resolveAppPaths(config, { platform: "win32", environment: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" }, homeDirectory: "C:\\Users\\tester", downloadsDirectory: "D:\\Redirected\\Downloads", cwd: "C:\\repo" });
  assert.equal(windows.dataRoot, "C:\\Users\\tester\\AppData\\Local\\Portus QC");
  assert.equal(windows.databasePath.endsWith("Portus QC\\state\\portus-qc.sqlite"), true);
  assert.equal(windows.mediaRoot.endsWith("Portus QC\\media"), true);
  assert.equal(windows.defaultArtifactRoot, "D:\\Redirected\\Downloads\\portus-qc-results");
  assert.equal(windows.artifactRoot, windows.defaultArtifactRoot);

  const linux = resolveAppPaths(config, { platform: "linux", environment: { XDG_DATA_HOME: "/home/tester/.data" }, homeDirectory: "/home/tester", downloadsDirectory: "/srv/user-downloads", cwd: "/repo" });
  assert.equal(linux.dataRoot, "/home/tester/.data/portus-qc");
  assert.equal(linux.mediaRoot, "/home/tester/.data/portus-qc/media");
  assert.equal(linux.defaultArtifactRoot, "/srv/user-downloads/portus-qc-results");
  assert.equal(linux.artifactRoot, linux.defaultArtifactRoot);
});
