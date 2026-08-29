import { access, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { spawn } from "node:child_process";

export interface ResolveExecutableOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
}

export class RuntimeExecutableNotFoundError extends Error {
  constructor(readonly executable: string) {
    super(`Required executable is not available: ${executable}.`);
    this.name = "RuntimeExecutableNotFoundError";
  }
}

export interface ExecutableProbeResult {
  executable: string;
  resolvedPath?: string;
  available: boolean;
  version?: string;
  error?: "not_found" | "failed" | "timeout";
}

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

function windowsExtensions(environment: NodeJS.ProcessEnv): readonly string[] {
  const raw = environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

async function regularFile(path: string): Promise<boolean> {
  try {
    await access(path);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function resolveExecutablePath(executable: string, options: ResolveExecutableOptions = {}): Promise<string | undefined> {
  const name = executable.trim();
  if (!name) return undefined;
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = pathApi(platform);
  const cwd = options.cwd ?? process.cwd();
  const hasPathSeparator = /[\\/]/u.test(name);
  if (paths.isAbsolute(name) || hasPathSeparator) {
    const candidate = paths.isAbsolute(name) ? paths.normalize(name) : paths.resolve(cwd, name);
    return await regularFile(candidate) ? candidate : undefined;
  }

  const delimiter = platform === "win32" ? ";" : ":";
  const directories = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = platform === "win32" && !paths.extname(name)
    ? windowsExtensions(environment)
    : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = paths.resolve(directory, `${name}${extension}`);
      if (await regularFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function requireExecutablePath(executable: string, options: ResolveExecutableOptions = {}): Promise<string> {
  const resolved = await resolveExecutablePath(executable, options);
  if (!resolved) throw new RuntimeExecutableNotFoundError(executable);
  return resolved;
}

export async function probeExecutable(
  executable: string,
  versionArgs: readonly string[],
  options: ResolveExecutableOptions & { timeoutMs?: number } = {}
): Promise<ExecutableProbeResult> {
  const resolvedPath = await resolveExecutablePath(executable, options);
  if (!resolvedPath) return { executable, available: false, error: "not_found" };
  const timeoutMs = options.timeoutMs ?? 3_000;
  return new Promise((resolveProbe) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(resolvedPath, [...versionArgs], {
      cwd: options.cwd ?? process.cwd(),
      env: options.environment ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const finish = (result: ExecutableProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveProbe(result);
    };
    child.once("error", () => finish({ executable, resolvedPath, available: false, error: "failed" }));
    child.once("close", (code) => {
      if (timedOut) return finish({ executable, resolvedPath, available: false, error: "timeout" });
      if (code !== 0) return finish({ executable, resolvedPath, available: false, error: "failed" });
      const version = [stdout, stderr]
        .flatMap((text) => text.split(/\r?\n/u))
        .map((line) => line.trim())
        .find(Boolean);
      finish({ executable, resolvedPath, available: true, ...(version ? { version } : {}) });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      hardKill.unref();
    }, timeoutMs);
    timer.unref();
  });
}
