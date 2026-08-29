import type { AppConfig, AppConfigOverrides } from "./schema";
import { AppConfigError, parseAppConfig } from "./schema";
import { loadRepositoryDefaults } from "./defaults";

export interface LoadAppConfigOptions {
  persisted?: AppConfigOverrides;
  environment?: NodeJS.ProcessEnv;
  session?: AppConfigOverrides;
}

function merge(base: AppConfig, overrides: AppConfigOverrides | undefined): AppConfig {
  if (!overrides) return base;
  return {
    runtime: { ...base.runtime, ...overrides.runtime },
    inference: { ...base.inference, ...overrides.inference },
    camera: { ...base.camera, ...overrides.camera },
    console: { ...base.console, ...overrides.console },
    scheduler: { ...base.scheduler, ...overrides.scheduler },
    video: { ...base.video, ...overrides.video },
    media: { ...base.media, ...overrides.media },
    artifacts: { ...base.artifacts, ...overrides.artifacts }
  };
}

function envInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new AppConfigError(`${name} must be an integer.`);
  return parsed;
}

export function environmentOverrides(environment: NodeJS.ProcessEnv = process.env): AppConfigOverrides {
  const port = envInteger(environment.PORTUS_QC_PORT, "PORTUS_QC_PORT");
  const timeoutMs = envInteger(environment.PORTUS_QC_MOONDREAM_TIMEOUT_MS, "PORTUS_QC_MOONDREAM_TIMEOUT_MS");
  const maxAttempts = envInteger(environment.PORTUS_QC_MOONDREAM_MAX_ATTEMPTS, "PORTUS_QC_MOONDREAM_MAX_ATTEMPTS");
  return {
    runtime: {
      ...(environment.PORTUS_QC_HOST ? { host: environment.PORTUS_QC_HOST } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(environment.PORTUS_QC_DATA_ROOT ? { dataRoot: environment.PORTUS_QC_DATA_ROOT } : {}),
      ...(environment.PORTUS_QC_CAMSNAP_EXECUTABLE ? { camsnapExecutable: environment.PORTUS_QC_CAMSNAP_EXECUTABLE } : {}),
      ...(environment.PORTUS_QC_FFMPEG_EXECUTABLE ? { ffmpegExecutable: environment.PORTUS_QC_FFMPEG_EXECUTABLE } : {})
    },
    inference: {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxAttempts !== undefined ? { maxAttempts } : {})
    }
  };
}

export async function loadAppConfig(options: LoadAppConfigOptions = {}): Promise<AppConfig> {
  const defaults = await loadRepositoryDefaults();
  const persisted = merge(defaults, options.persisted);
  const environment = merge(persisted, environmentOverrides(options.environment));
  return parseAppConfig(merge(environment, options.session));
}
