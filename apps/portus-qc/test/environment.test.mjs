import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDotEnvFile, mergeEnvironment, parseDotEnv } from "../config/environment.ts";

test("dotenv parser accepts the documented Moondream API-key fallback without interpolation", () => {
  assert.deepEqual(parseDotEnv(`
# Portus QC local development
MOONDREAM_API_KEY=secret-value
PORTUS_QC_PORT=4100
IGNORED_LINE
`), {
    MOONDREAM_API_KEY: "secret-value",
    PORTUS_QC_PORT: "4100"
  });
});

test("dotenv file loading is optional and process environment still wins for ordinary non-secret config", async () => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-dotenv-"));
  try {
    const file = join(root, "fixture.env");
    await writeFile(file, "PORTUS_QC_PORT=4100\nPORTUS_QC_HOST=localhost\n", "utf8");
    const dotenv = await loadDotEnvFile(file);
    assert.deepEqual(mergeEnvironment(dotenv, { PORTUS_QC_PORT: "4200" }), {
      PORTUS_QC_PORT: "4200",
      PORTUS_QC_HOST: "localhost"
    });
    assert.deepEqual(await loadDotEnvFile(join(root, "missing.env")), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
