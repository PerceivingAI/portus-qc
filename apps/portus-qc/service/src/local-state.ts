import { mkdir } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { AppConfig } from "../../config/schema";
import { loadDotEnvFile, mergeEnvironment, repositoryDotEnvPath } from "../../config/environment";
import { loadAppConfig } from "../../config/load";
import { FileSystemMediaStore } from "./media/store";
import { resolveAppPaths, type AppPaths } from "./persistence/paths";
import { openStateRepository, type StateRepository } from "./persistence/repository";
import { SqliteAppSettingsRepository, type AppSettingsRepository } from "./persistence/settings";
import { DotEnvFallbackSecretStore } from "./secrets/environment";
import { FileSecretStore, type SecretStore } from "./secrets/store";
import { discoverDownloadsDirectory } from "./runtime/user-folders";

export interface LocalApplicationState {
  readonly config: AppConfig;
  readonly paths: AppPaths;
  readonly stateRepository: StateRepository;
  readonly settings: AppSettingsRepository;
  readonly secrets: SecretStore;
  readonly media: FileSystemMediaStore;
  close(): void;
}

export interface OpenLocalApplicationStateOptions {
  environment?: NodeJS.ProcessEnv;
  /** Test/bootstrap injection for repository .env values without reading the real root .env. */
  dotEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  downloadsDirectory?: string;
  cwd?: string;
}

export async function openLocalApplicationState(options: OpenLocalApplicationStateOptions = {}): Promise<LocalApplicationState> {
  const baseEnvironment = options.environment ?? process.env;
  const dotEnv = options.dotEnv ?? (options.environment === undefined ? await loadDotEnvFile(repositoryDotEnvPath) : {});
  const environment = mergeEnvironment(dotEnv, baseEnvironment);
  const platform = options.platform ?? process.platform;
  const downloadsDirectory = options.downloadsDirectory ?? (options.homeDirectory
    ? (platform === "win32" ? win32 : posix).join(options.homeDirectory, "Downloads")
    : await discoverDownloadsDirectory({ environment, platform }));
  const bootstrapConfig = await loadAppConfig({ environment });
  const bootstrapPaths = resolveAppPaths(bootstrapConfig, {
    environment,
    platform,
    ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}),
    downloadsDirectory,
    ...(options.cwd ? { cwd: options.cwd } : {})
  });
  await mkdir(bootstrapPaths.dataRoot, { recursive: true, mode: 0o700 });
  const stateRepository = await openStateRepository(bootstrapPaths.databasePath);

  try {
    const settings = new SqliteAppSettingsRepository(stateRepository);
    const persisted = await settings.load();
    const config = await loadAppConfig({ environment, ...(persisted ? { persisted } : {}) });
    const paths = resolveAppPaths(config, {
      environment,
      platform,
      ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}),
      downloadsDirectory,
      ...(options.cwd ? { cwd: options.cwd } : {})
    });
    if (paths.dataRoot !== bootstrapPaths.dataRoot) throw new Error("Persisted settings cannot move the active Portus QC data root. Use PORTUS_QC_DATA_ROOT before startup.");
    await mkdir(paths.mediaRoot, { recursive: true, mode: 0o700 });
    await mkdir(paths.secretsRoot, { recursive: true, mode: 0o700 });
    await mkdir(paths.artifactRoot, { recursive: true });
    const fileSecrets = new FileSecretStore(paths.secretsRoot);
    const secrets = new DotEnvFallbackSecretStore(fileSecrets, dotEnv);
    const media = new FileSystemMediaStore(paths.mediaRoot);
    return {
      config,
      paths,
      stateRepository,
      settings,
      secrets,
      media,
      close(): void { stateRepository.close(); }
    };
  } catch (error) {
    stateRepository.close();
    throw error;
  }
}
