import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CamsnapOperationalError,
  classifyCamsnapFailure,
  validateCamsnapCamera,
  type CamsnapCameraConfig,
  type CamsnapCredentialProvider,
  type CamsnapRuntime
} from "./index";

export interface CamsnapProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CamsnapProcessRunner = (executable: string, argv: readonly string[], timeoutMs: number) => Promise<CamsnapProcessResult>;

export interface CamsnapCliRuntimeOptions {
  configPath: string;
  credentials: CamsnapCredentialProvider;
  executable?: string;
  processRunner?: CamsnapProcessRunner;
  now?: () => string;
}

export class CamsnapCliRuntime implements CamsnapRuntime {
  readonly #configPath: string;
  readonly #credentials: CamsnapCredentialProvider;
  readonly #executable: string;
  readonly #processRunner: CamsnapProcessRunner;
  readonly #now: () => string;
  readonly #configured = new Map<string, string>();

  constructor(options: CamsnapCliRuntimeOptions) {
    if (!options.configPath.trim()) throw new Error("Camsnap configPath is required.");
    this.#configPath = options.configPath;
    this.#credentials = options.credentials;
    this.#executable = options.executable?.trim() || "camsnap";
    this.#processRunner = options.processRunner ?? runCamsnapProcess;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async discover(input: { timeoutMs: number }): Promise<{ output: string }> {
    const result = await this.#run(["discover", "--timeout", durationArg(input.timeoutMs), "--info"], input.timeoutMs + 2_000);
    this.#assertProcessSuccess(result, "Camera discovery");
    return { output: combineOutput(result) };
  }

  async probe(camera: CamsnapCameraConfig, input: { timeoutMs: number }): Promise<{ ok: boolean; output: string }> {
    const alias = await this.#ensureConfigured(camera, input.timeoutMs);
    const args = ["doctor", "--probe", "--timeout", durationArg(input.timeoutMs)];
    if (camera.transport) args.push("--rtsp-transport", camera.transport);
    if (camera.rtspAuth) args.push("--rtsp-auth", camera.rtspAuth);
    const result = await this.#run(args, input.timeoutMs + 2_000);
    if (result.timedOut) throw new CamsnapOperationalError("timeout", "Camera health probe timed out.");
    const output = combineOutput(result);
    const failed = output.split(/\r?\n/u).some((line) => line.includes(alias) && (line.includes("✖") || line.toLowerCase().includes("failed")));
    return { ok: result.exitCode === 0 && !failed, output };
  }

  async snapshot(camera: CamsnapCameraConfig, input: { timeoutMs: number }): Promise<{ bytes: Uint8Array; mimeType: "image/jpeg"; width: number; height: number; capturedAt: string }> {
    const alias = await this.#ensureConfigured(camera, input.timeoutMs);
    const workDir = await mkdtemp(join(tmpdir(), "portus-camsnap-snapshot-"));
    const outputPath = join(workDir, "snapshot.jpg");
    try {
      const args = ["snap", alias, "--out", outputPath, "--rtsp-client", camera.rtspClient ?? "gortsplib"];
      appendRuntimeCameraOptions(args, camera, false);
      const result = await this.#run(args, input.timeoutMs);
      this.#assertProcessSuccess(result, "Camera snapshot");
      const bytes = new Uint8Array(await readFile(outputPath));
      const { width, height } = jpegDimensions(bytes);
      return { bytes, mimeType: "image/jpeg", width, height, capturedAt: this.#now() };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async clip(camera: CamsnapCameraConfig, input: { timeoutMs: number; durationMs: number }): Promise<{ bytes: Uint8Array; mimeType: string; capturedAt: string }> {
    const alias = await this.#ensureConfigured(camera, input.timeoutMs);
    const workDir = await mkdtemp(join(tmpdir(), "portus-camsnap-clip-"));
    const outputPath = join(workDir, "clip.mp4");
    try {
      const args = ["clip", alias, "--dur", durationArg(input.durationMs), "--out", outputPath];
      appendRuntimeCameraOptions(args, camera, false);
      const result = await this.#run(args, input.timeoutMs);
      this.#assertProcessSuccess(result, "Camera clip");
      const bytes = new Uint8Array(await readFile(outputPath));
      return { bytes, mimeType: "video/mp4", capturedAt: this.#now() };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async #ensureConfigured(camera: CamsnapCameraConfig, timeoutMs: number): Promise<string> {
    validateCamsnapCamera(camera);
    const existing = this.#configured.get(camera.id);
    if (existing) return existing;
    const alias = cameraAlias(camera.id);
    const credentials = await this.#credentials(camera);
    if (!credentials.username.trim() || !credentials.password) throw new CamsnapOperationalError("auth_invalid", `Camera ${camera.id} requires credentials.`);
    const args = ["add", "--name", alias, "--host", camera.host, "--user", credentials.username, "--pass", credentials.password];
    if (camera.port !== undefined) args.push("--port", String(camera.port));
    if (camera.protocol) args.push("--protocol", camera.protocol);
    if (camera.stream) args.push("--stream", camera.stream);
    if (camera.path) args.push("--path", camera.path);
    if (camera.transport) args.push("--rtsp-transport", camera.transport);
    if (camera.rtspClient) args.push("--rtsp-client", camera.rtspClient);
    const result = await this.#run(args, timeoutMs);
    this.#assertProcessSuccess(result, "Camera configuration");
    this.#configured.set(camera.id, alias);
    return alias;
  }

  async #run(argv: readonly string[], timeoutMs: number): Promise<CamsnapProcessResult> {
    await mkdir(dirname(this.#configPath), { recursive: true });
    return this.#processRunner(this.#executable, ["--config", this.#configPath, ...argv], timeoutMs);
  }

  #assertProcessSuccess(result: CamsnapProcessResult, operation: string): void {
    if (result.timedOut) throw new CamsnapOperationalError("timeout", `${operation} timed out.`);
    if (result.exitCode === 0) return;
    const code = classifyCamsnapFailure(combineOutput(result));
    throw new CamsnapOperationalError(code, `${operation} failed (${code}).`);
  }
}

function appendRuntimeCameraOptions(args: string[], camera: CamsnapCameraConfig, includeClient = true): void {
  if (camera.stream) args.push("--stream", camera.stream);
  if (camera.path) args.push("--path", camera.path);
  if (camera.transport) args.push("--rtsp-transport", camera.transport);
  if (includeClient && camera.rtspClient) args.push("--rtsp-client", camera.rtspClient);
  if (camera.rtspAuth) args.push("--rtsp-auth", camera.rtspAuth);
}

function durationArg(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("Duration must be a positive finite number.");
  return `${Math.ceil(milliseconds)}ms`;
}

function combineOutput(result: CamsnapProcessResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function cameraAlias(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "camera";
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `portus-${safe}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new CamsnapOperationalError("invalid_output", "Camsnap snapshot is not a JPEG image.");
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 1 >= bytes.length) break;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) break;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xc3 || marker >= 0xc5 && marker <= 0xc7 || marker >= 0xc9 && marker <= 0xcb || marker >= 0xcd && marker <= 0xcf;
    if (isStartOfFrame) {
      if (length < 7) break;
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    offset += length;
  }
  throw new CamsnapOperationalError("invalid_output", "Camsnap snapshot JPEG dimensions could not be read.");
}

function processRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function terminateProcessTree(child: ChildProcess, hardKillDelayMs = 2_000): () => void {
  if (!processRunning(child)) return () => undefined;
  const pid = child.pid;
  let fallbackTimer: NodeJS.Timeout | undefined;
  let hardKillTimer: NodeJS.Timeout | undefined;

  const directKill = (signal: NodeJS.Signals = "SIGKILL"): void => {
    if (!processRunning(child)) return;
    try { child.kill(signal); } catch { /* process may have exited between checks */ }
  };

  if (process.platform === "win32" && pid) {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        shell: false,
        stdio: "ignore"
      });
      killer.once("error", () => directKill());
      killer.once("close", (code) => { if (code !== 0) directKill(); });
      killer.unref();
      fallbackTimer = setTimeout(() => directKill(), hardKillDelayMs);
      fallbackTimer.unref();
    } catch {
      directKill();
    }
  } else {
    if (pid) {
      try { process.kill(-pid, "SIGTERM"); }
      catch { directKill("SIGTERM"); }
    } else {
      directKill("SIGTERM");
    }
    hardKillTimer = setTimeout(() => {
      if (!processRunning(child)) return;
      if (pid) {
        try { process.kill(-pid, "SIGKILL"); }
        catch { directKill(); }
      } else {
        directKill();
      }
    }, hardKillDelayMs);
    hardKillTimer.unref();
  }

  return () => {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    if (hardKillTimer) clearTimeout(hardKillTimer);
  };
}

export const runCamsnapProcess: CamsnapProcessRunner = async (executable, argv, timeoutMs) => new Promise((resolve) => {
  let timedOut = false;
  let settled = false;
  let stdout = "";
  let stderr = "";
  let timer: NodeJS.Timeout | undefined;
  let cancelTermination: (() => void) | undefined;
  const child = spawn(executable, [...argv], {
    windowsHide: true,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const finish = (exitCode: number | null): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    cancelTermination?.();
    resolve({ exitCode, stdout, stderr, timedOut });
  };
  child.on("error", (error: Error) => {
    stderr += error.message;
    finish(null);
  });
  child.on("close", (code: number | null) => finish(code));
  timer = setTimeout(() => {
    timedOut = true;
    cancelTermination = terminateProcessTree(child);
  }, timeoutMs);
  timer.unref();
});
