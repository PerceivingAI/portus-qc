import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { openLocalApplicationState } from "../src/local-state.ts";
import { createApplicationRuntime } from "../src/runtime/index.ts";
import { bundledCamsnapExecutablePath, resolveCamsnapExecutable } from "../src/runtime/camsnap.ts";
import { resolveExecutablePath, probeExecutable } from "../src/runtime/executable.ts";
import { RuntimeNotConfiguredError } from "../src/runtime/moondream.ts";
import { browserLaunchCommand } from "../src/runtime/browser.ts";
import { secretKeys } from "../src/secrets/store.ts";

test("browser auto-open accepts only local Console URLs and chooses a platform launcher", () => {
  assert.deepEqual(browserLaunchCommand("http://127.0.0.1:3210", "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "start", "", "http://127.0.0.1:3210"]
  });
  assert.deepEqual(browserLaunchCommand("http://localhost:3210", "darwin"), { command: "open", args: ["http://localhost:3210"] });
  assert.deepEqual(browserLaunchCommand("http://127.0.0.1:3210", "linux"), { command: "xdg-open", args: ["http://127.0.0.1:3210"] });
  assert.throws(() => browserLaunchCommand("https://example.com", "win32"), /loopback/u);
});

test("executable resolution uses PATH and native executable suffix rules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-runtime-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = process.platform === "win32" ? "camsnap.exe" : "camsnap";
  const executable = join(root, filename);
  await writeFile(executable, "placeholder", "utf8");
  const environment = {
    PATH: [root, "unused"].join(delimiter),
    ...(process.platform === "win32" ? { PATHEXT: ".EXE;.CMD" } : {})
  };
  assert.equal(await resolveExecutablePath("camsnap", { environment, platform: process.platform }), executable);
  assert.equal(await resolveExecutablePath("missing-tool", { environment, platform: process.platform }), undefined);
});

test("default Windows Camsnap runtime resolves the app-bundled executable before PATH", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") return;
  const root = await mkdtemp(join(tmpdir(), "portus-qc-bundled-camsnap-"));
  const state = await openLocalApplicationState({ environment: { PORTUS_QC_DATA_ROOT: root } });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });

  const bundled = bundledCamsnapExecutablePath("win32", "x64");
  assert.ok(bundled);
  assert.equal(await resolveCamsnapExecutable(state.config, { platform: "win32", arch: "x64", environment: { PATH: "" } }), bundled);

  const overrideConfig = { ...state.config, runtime: { ...state.config.runtime, camsnapExecutable: process.execPath } };
  assert.equal(await resolveCamsnapExecutable(overrideConfig), process.execPath);
});

test("executable probing reports a real executable version without shell execution", async () => {
  const result = await probeExecutable(process.execPath, ["--version"], { timeoutMs: 3_000 });
  assert.equal(result.available, true);
  assert.equal(result.resolvedPath, process.execPath);
  assert.match(result.version ?? "", /^v\d+\./u);
});

test("Moondream uses repository .env only as fallback while process API-key/model variables are ignored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-runtime-dotenv-"));
  const dotEnvKey = "dotenv-moonda-secret";
  const state = await openLocalApplicationState({
    environment: {
      PORTUS_QC_DATA_ROOT: root,
      MOONDREAM_API_KEY: "ignored-process-secret",
      MOONDREAM_MODEL: "ignored-process-model"
    },
    dotEnv: { MOONDREAM_API_KEY: dotEnvKey }
  });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(state.config.inference.model, "moondream3.1-9B-A2B");
  assert.equal(await state.secrets.get(secretKeys.moondreamApiKey), dotEnvKey);
  assert.equal(await state.secrets.source?.(secretKeys.moondreamApiKey), "dotenv");
  const secretFiles = await (await import("node:fs/promises")).readdir(state.paths.secretsRoot);
  assert.deepEqual(secretFiles, []);

  await state.secrets.set(secretKeys.moondreamApiKey, "saved-gui-secret");
  assert.equal(await state.secrets.get(secretKeys.moondreamApiKey), "saved-gui-secret");
  assert.equal(await state.secrets.source?.(secretKeys.moondreamApiKey), "persistent");
  await state.secrets.delete(secretKeys.moondreamApiKey);
  assert.equal(await state.secrets.get(secretKeys.moondreamApiKey), dotEnvKey);

  const sqliteBytes = await (await import("node:fs/promises")).readFile(state.paths.databasePath);
  assert.equal(sqliteBytes.toString("utf8").includes(dotEnvKey), false);
  assert.equal(await createApplicationRuntime(state).moondreamConfigured(), true);
});

test("application runtime centralizes Moondream and engine construction behind the secret store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portus-qc-runtime-state-"));
  const state = await openLocalApplicationState({ environment: {
    PORTUS_QC_DATA_ROOT: root,
    PORTUS_QC_CAMSNAP_EXECUTABLE: process.execPath,
    PORTUS_QC_FFMPEG_EXECUTABLE: process.execPath
  } });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  const runtime = createApplicationRuntime(state);

  assert.equal(await runtime.moondreamConfigured(), false);
  await assert.rejects(() => runtime.createMoondream(), (error) => error instanceof RuntimeNotConfiguredError && error.component === "moondream");

  await state.secrets.set(secretKeys.moondreamApiKey, "test-moonda-key");
  assert.equal(await runtime.moondreamConfigured(), true);
  const provider = await runtime.createMoondream();
  assert.equal(provider.id, "moondream");
  assert.equal(provider.model, state.config.inference.model);
  const classifier = await runtime.createMoondreamClassifier();
  assert.equal(classifier.id, "moondream");
  assert.equal(classifier.model, state.config.inference.model);
  assert.ok(await runtime.createEngine());
  const { mkdir, readdir, writeFile } = await import("node:fs/promises");
  const camsnapRoot = join(state.paths.stateRoot, "camsnap");
  await mkdir(camsnapRoot, { recursive: true });
  await writeFile(join(camsnapRoot, "config.yaml"), "legacy-plaintext-projection", "utf8");
  assert.equal(await runtime.withCamsnap(async () => "temporary-runtime-ok"), "temporary-runtime-ok");
  assert.deepEqual(await readdir(camsnapRoot), []);
  assert.equal(await runtime.resolveFfmpeg(), process.execPath);
});
