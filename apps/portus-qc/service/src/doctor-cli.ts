import { createCameraService } from "./domain/cameras";
import { runDoctor } from "./doctor";
import { openLocalApplicationState } from "./local-state";
import { SqliteCameraRepository } from "./persistence/cameras";
import { createApplicationRuntime } from "./runtime";

const STATUS_LABEL = {
  ok: "OK",
  attention: "ATTENTION",
  error: "ERROR"
} as const;

async function main(): Promise<void> {
  const state = await openLocalApplicationState();
  try {
    const runtime = createApplicationRuntime(state);
    const cameras = createCameraService({
      repository: new SqliteCameraRepository(state.stateRepository, state.config.camera),
      secrets: state.secrets,
      runtime,
      defaults: state.config.camera,
      config: state.config,
      settingsRepository: state.settings
    });
    const report = await runDoctor(state, runtime, { cameras });
    console.log(`Portus QC Doctor: ${report.status.toUpperCase()}`);
    for (const check of report.checks) {
      console.log(`[${STATUS_LABEL[check.status]}] ${check.label}: ${check.message}`);
    }
    if (report.status === "error") process.exitCode = 1;
  } finally {
    state.close();
  }
}

main().catch((error: unknown) => {
  console.error("Portus QC Doctor failed.", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
