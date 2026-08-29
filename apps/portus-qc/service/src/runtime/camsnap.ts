import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CamsnapOperationalError,
  type CamsnapCredentialProvider,
  type CamsnapCredentials,
  type CamsnapRuntime
} from "@portus-qc/camsnap";
import { CamsnapCliRuntime } from "@portus-qc/camsnap/node-runtime";
import type { AppConfig } from "../../../config/schema";
import type { AppPaths } from "../persistence/paths";
import { secretKeys, type SecretStore } from "../secrets/store";
import { probeExecutable, requireExecutablePath, resolveExecutablePath, RuntimeExecutableNotFoundError, type ExecutableProbeResult, type ResolveExecutableOptions } from "./executable";

const DEFAULT_CAMSNAP_EXECUTABLE = "camsnap";

export function bundledCamsnapExecutablePath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | undefined {
  if (platform === "win32" && arch === "x64") {
    return fileURLToPath(new URL("../../../vendor/camsnap/windows-x64/camsnap.exe", import.meta.url));
  }
  return undefined;
}

export async function resolveCamsnapExecutable(
  config: AppConfig,
  options: ResolveExecutableOptions & { arch?: string } = {}
): Promise<string> {
  const configured = config.runtime.camsnapExecutable.trim();
  if (configured !== DEFAULT_CAMSNAP_EXECUTABLE) return requireExecutablePath(configured, options);

  const platform = options.platform ?? process.platform;
  const bundled = bundledCamsnapExecutablePath(platform, options.arch ?? process.arch);
  if (bundled) {
    const resolvedBundled = await resolveExecutablePath(bundled, options);
    if (resolvedBundled) return resolvedBundled;
  }

  return requireExecutablePath(configured, options);
}

export function createCamsnapCredentialProvider(secrets: SecretStore): CamsnapCredentialProvider {
  return async (camera) => {
    const [username, password] = await Promise.all([
      secrets.get(secretKeys.cameraUsername(camera.id)),
      secrets.get(secretKeys.cameraPassword(camera.id))
    ]);
    if (!username?.trim() || !password) {
      throw new CamsnapOperationalError("auth_invalid", `Camera ${camera.id} credentials are not configured.`);
    }
    return { username, password };
  };
}

function fixedCredentials(credentials: CamsnapCredentials): CamsnapCredentialProvider {
  return async () => credentials;
}

export async function withCamsnapRuntime<T>(input: {
  config: AppConfig;
  paths: AppPaths;
  secrets: SecretStore;
  credentials?: CamsnapCredentials;
}, operation: (runtime: CamsnapRuntime) => Promise<T>): Promise<T> {
  const workRoot = join(input.paths.stateRoot, "camsnap");
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  // Remove the pre-S7 persistent projection even if executable resolution later fails.
  // SQLite + SecretStore are authoritative; generated Camsnap configuration is disposable.
  await rm(join(workRoot, "config.yaml"), { force: true });
  const executable = await resolveCamsnapExecutable(input.config);
  const runRoot = await mkdtemp(join(workRoot, "run-"));
  try {
    const runtime = new CamsnapCliRuntime({
      executable,
      configPath: join(runRoot, "config.yaml"),
      credentials: input.credentials ? fixedCredentials(input.credentials) : createCamsnapCredentialProvider(input.secrets)
    });
    return await operation(runtime);
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

export async function probeCamsnapExecutable(
  config: AppConfig,
  options: ResolveExecutableOptions & { timeoutMs?: number; arch?: string } = {}
): Promise<ExecutableProbeResult> {
  try {
    const executable = await resolveCamsnapExecutable(config, options);
    return probeExecutable(executable, ["--version"], options);
  } catch (error) {
    if (error instanceof RuntimeExecutableNotFoundError) {
      return { executable: config.runtime.camsnapExecutable, available: false, error: "not_found" };
    }
    throw error;
  }
}
