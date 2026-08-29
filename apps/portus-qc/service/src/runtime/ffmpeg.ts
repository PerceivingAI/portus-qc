import type { AppConfig } from "../../../config/schema";
import { probeExecutable, requireExecutablePath, type ExecutableProbeResult, type ResolveExecutableOptions } from "./executable";

export function resolveFfmpegExecutable(
  config: AppConfig,
  options: ResolveExecutableOptions = {}
): Promise<string> {
  return requireExecutablePath(config.runtime.ffmpegExecutable, options);
}

export function probeFfmpegExecutable(
  config: AppConfig,
  options: ResolveExecutableOptions & { timeoutMs?: number } = {}
): Promise<ExecutableProbeResult> {
  return probeExecutable(config.runtime.ffmpegExecutable, ["-version"], options);
}
