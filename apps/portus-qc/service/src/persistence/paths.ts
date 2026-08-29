import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { AppConfig } from "../../../config/schema";

export interface AppPaths {
  dataRoot: string;
  stateRoot: string;
  databasePath: string;
  secretsRoot: string;
  mediaRoot: string;
  defaultArtifactRoot: string;
  artifactRoot: string;
}

export interface ResolveArtifactRootOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  downloadsDirectory?: string;
}

export interface ResolveAppPathsOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  downloadsDirectory?: string;
  cwd?: string;
}

type PathApi = typeof posix;

function pathApiFor(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? win32 : posix;
}

function defaultDataRoot(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDirectory: string, pathApi: PathApi): string {
  if (platform === "win32") return pathApi.join(environment.LOCALAPPDATA || pathApi.join(homeDirectory, "AppData", "Local"), "Portus QC");
  if (platform === "darwin") return pathApi.join(homeDirectory, "Library", "Application Support", "Portus QC");
  return pathApi.join(environment.XDG_DATA_HOME || pathApi.join(homeDirectory, ".local", "share"), "portus-qc");
}

function defaultDownloadsRoot(platform: NodeJS.Platform, homeDirectory: string, downloadsDirectory: string | undefined, pathApi: PathApi): string {
  const downloads = downloadsDirectory && pathApi.isAbsolute(downloadsDirectory)
    ? pathApi.normalize(downloadsDirectory)
    : pathApi.join(homeDirectory, "Downloads");
  return pathApi.join(downloads, "portus-qc-results");
}

function configuredPath(value: string | null, base: string, cwd: string, pathApi: PathApi): string {
  if (value === null) return base;
  return pathApi.isAbsolute(value) ? pathApi.resolve(value) : pathApi.resolve(cwd, value);
}

export function resolveArtifactRoot(root: string | null, options: ResolveArtifactRootOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const paths = pathApiFor(platform);
  return root === null
    ? defaultDownloadsRoot(platform, homeDirectory, options.downloadsDirectory, paths)
    : paths.resolve(root);
}

export function resolveAppPaths(config: AppConfig, options: ResolveAppPathsOptions = {}): AppPaths {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const pathApi = pathApiFor(platform);
  const dataRoot = configuredPath(config.runtime.dataRoot, defaultDataRoot(environment, platform, homeDirectory, pathApi), cwd, pathApi);
  const stateRoot = pathApi.join(dataRoot, "state");
  const mediaRoot = config.media.root === null
    ? pathApi.join(dataRoot, "media")
    : pathApi.isAbsolute(config.media.root) ? pathApi.resolve(config.media.root) : pathApi.resolve(dataRoot, config.media.root);
  const artifactOptions: ResolveArtifactRootOptions = {
    platform,
    homeDirectory,
    ...(options.downloadsDirectory !== undefined ? { downloadsDirectory: options.downloadsDirectory } : {})
  };
  const defaultArtifactRoot = resolveArtifactRoot(null, artifactOptions);
  const artifactRoot = config.artifacts.root === null
    ? defaultArtifactRoot
    : resolveArtifactRoot(config.artifacts.root, artifactOptions);
  return {
    dataRoot,
    stateRoot,
    databasePath: pathApi.join(stateRoot, "portus-qc.sqlite"),
    secretsRoot: pathApi.join(dataRoot, "secrets"),
    mediaRoot,
    defaultArtifactRoot,
    artifactRoot
  };
}
