import assert from "node:assert/strict";
import test from "node:test";
import { loadRepositoryDefaults } from "../config/defaults.ts";
import { loadAppConfig } from "../config/load.ts";
import { parseAppConfig } from "../config/schema.ts";

test("repository defaults form a valid config with loopback-safe runtime defaults", async () => {
  const config = await loadRepositoryDefaults();
  assert.equal(config.runtime.host, "127.0.0.1");
  assert.equal(config.inference.provider, "moondream");
  assert.equal(config.inference.maxRequestsPerSecond, 2);
  assert.equal(config.scheduler.overlapPolicy, "drop");
  assert.equal(config.video.framesPerSecond, 4);
  assert.equal(config.video.maxOutstandingInferences, 1);
  assert.equal(config.media.maxAgeDays, 30);
  assert.equal("retainPass" in config.media, false);
  assert.equal(config.artifacts.root, null);
});

test("config precedence keeps GUI-persisted model authoritative over environment variables", async () => {
  const config = await loadAppConfig({
    persisted: { runtime: { port: 4000 }, inference: { model: "persisted-model" } },
    environment: { PORTUS_QC_PORT: "4100", MOONDREAM_MODEL: "ignored-env-model", PORTUS_QC_MOONDREAM_MODEL: "also-ignored" },
    session: { runtime: { port: 4200 } }
  });
  assert.equal(config.runtime.port, 4200);
  assert.equal(config.inference.model, "persisted-model");
});

test("invalid QC-relevant configuration fails closed with actionable errors", async () => {
  const defaults = await loadRepositoryDefaults();
  assert.throws(() => parseAppConfig({ ...defaults, scheduler: { ...defaults.scheduler, minIntervalMs: 60_000, maxIntervalMs: 10_000 } }), /must not exceed/u);
  await assert.rejects(() => loadAppConfig({ environment: { PORTUS_QC_PORT: "not-a-port" } }), /PORTUS_QC_PORT/u);
  await assert.rejects(() => loadAppConfig({ environment: { PORTUS_QC_DATA_ROOT: "relative-data" } }), /absolute path/u);
  assert.throws(() => parseAppConfig({ ...defaults, artifacts: { ...defaults.artifacts, root: "relative-results" } }), /artifacts.root must be an absolute path/u);
  assert.throws(() => parseAppConfig({ ...defaults, inference: { ...defaults.inference, maxRequestsPerSecond: 0 } }), /maxRequestsPerSecond/u);
  assert.throws(() => parseAppConfig({ ...defaults, video: { ...defaults.video, framesPerSecond: 3 } }), /video.framesPerSecond/u);
  assert.throws(() => parseAppConfig({ ...defaults, video: { ...defaults.video, framesPerSecond: 9 } }), /video.framesPerSecond/u);
});
