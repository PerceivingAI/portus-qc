import { loadRepositoryDefaults } from "../../config/defaults";
import { openLocalApplicationState } from "./local-state";
import { createApplicationRuntime } from "./runtime";
import { runDoctor } from "./doctor";
import { createInspectionService } from "./domain/inspections";
import { SqliteInspectionRepository } from "./persistence/inspections";
import { SqliteResultRepository } from "./persistence/results";
import { SqliteCameraRepository } from "./persistence/cameras";
import { SqliteScheduleRepository } from "./persistence/schedules";
import { createCameraService } from "./domain/cameras";
import { createCalibrationService } from "./domain/calibration";
import { createArtifactService } from "./domain/artifacts";
import { createInspectionRunService } from "./domain/inspection-runs";
import { createResultService } from "./domain/results";
import { createMoondreamSettingsService } from "./domain/moondream-settings";
import { createScheduleService } from "./domain/schedules";
import { createVideoSessionService } from "./domain/video";
import { createConsoleLifecycleService } from "./domain/console-lifecycle";
import { createNativeFolderPicker } from "./runtime/folder-picker";
import { openLocalBrowser } from "./runtime/browser";
import { createFfmpegFrameExtractor } from "./runtime/video";
import { startPortusQcService } from "./server";

async function main(): Promise<void> {
  const state = await openLocalApplicationState();
  const runtime = createApplicationRuntime(state);
  const inspections = createInspectionService(new SqliteInspectionRepository(state.stateRepository));
  const resultRepository = new SqliteResultRepository(state.stateRepository);
  const cameras = createCameraService({
    repository: new SqliteCameraRepository(state.stateRepository, state.config.camera),
    secrets: state.secrets,
    runtime,
    defaults: state.config.camera,
    config: state.config,
    settingsRepository: state.settings
  });
  const calibration = createCalibrationService({ runtime });
  const repositoryDefaults = await loadRepositoryDefaults();
  const moondreamSettings = createMoondreamSettingsService({
    secrets: state.secrets,
    config: state.config,
    settingsRepository: state.settings,
    defaultModel: repositoryDefaults.inference.model
  });
  const artifacts = createArtifactService({
    initialRoot: state.paths.artifactRoot,
    defaultRoot: state.paths.defaultArtifactRoot,
    initialConfiguredRoot: state.config.artifacts.root,
    results: resultRepository,
    media: state.media,
    settingsRepository: state.settings,
    folderPicker: createNativeFolderPicker()
  });
  const results = createResultService({ results: resultRepository, media: state.media });
  const runs = createInspectionRunService({
    cameras,
    inspections,
    runtime,
    results: resultRepository,
    artifacts,
    media: state.media,
    mediaConfig: state.config.media
  });
  const schedules = createScheduleService({
    repository: new SqliteScheduleRepository(state.stateRepository),
    cameras,
    runs,
    config: state.config.scheduler,
    onError: (error) => console.warn("Scheduled inspection cycle failed.", error instanceof Error ? error.message : error)
  });
  const video = createVideoSessionService({
    cameras,
    inspections,
    runs,
    runtime,
    extractor: createFfmpegFrameExtractor({ resolveExecutable: () => runtime.resolveFfmpeg() }),
    config: state.config.video,
    onError: (error) => console.warn("Video inspection session failed.", error instanceof Error ? error.message : error)
  });
  let service: Awaited<ReturnType<typeof startPortusQcService>> | undefined;
  let shuttingDown = false;
  let consoleLifecycle: ReturnType<typeof createConsoleLifecycleService> | undefined;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${reason}; stopping Portus QC local service...`);
    try {
      consoleLifecycle?.stop();
      if (service) await service.stop();
      await Promise.all([schedules.stop(), video.shutdown()]);
      state.close();
      console.log("Portus QC local service stopped.");
    } catch (error) {
      console.error("Portus QC local service shutdown failed.", error);
      process.exitCode = 1;
    }
  };
  consoleLifecycle = createConsoleLifecycleService({
    onEmpty: () => shutdown("Console closed"),
    onError: (error) => console.error("Console lifecycle shutdown failed.", error)
  });

  try {
    service = await startPortusQcService({
      config: state.config,
      runDoctor: () => runDoctor(state, runtime, { cameras }),
      inspections,
      artifacts,
      cameras,
      calibration,
      runs,
      results,
      moondreamSettings,
      schedules,
      video,
      consoleLifecycle
    });
    await schedules.start();
  } catch (error) {
    consoleLifecycle.stop();
    await Promise.allSettled([schedules.stop(), video.shutdown()]);
    if (service) await service.stop().catch(() => undefined);
    state.close();
    throw error;
  }

  console.log(`Portus QC local service running at ${service.url}`);
  console.log(`Health: ${service.url}/health`);
  console.log(`Doctor: ${service.url}/api/doctor`);
  console.log(`Local data: ${state.paths.dataRoot}`);
  console.log(`Results: ${artifacts.settings().root}`);

  if (state.config.runtime.openBrowser) {
    void openLocalBrowser(service.url).catch((error: unknown) => {
      console.warn("Portus QC could not open the local Console automatically.", error instanceof Error ? error.message : error);
    });
  }

  process.once("SIGINT", () => { void shutdown("Received SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("Received SIGTERM"); });
}

main().catch((error: unknown) => {
  console.error("Portus QC local service failed to start.", error);
  process.exitCode = 1;
});
