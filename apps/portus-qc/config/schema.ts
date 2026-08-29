import { isAbsolute } from "node:path";

export interface RuntimeConfig {
  schemaVersion: 1;
  host: string;
  port: number;
  openBrowser: boolean;
  dataRoot: string | null;
  camsnapExecutable: string;
  ffmpegExecutable: string;
}

export interface InferenceConfig {
  schemaVersion: 1;
  provider: "moondream";
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  maxRequestsPerSecond: number;
}

export interface CameraDefaults {
  schemaVersion: 1;
  protocol: "rtsp" | "rtsps";
  stream: "stream1" | "stream2";
  transport: "tcp" | "udp";
  rtspClient: "gortsplib" | "ffmpeg";
  rtspAuth: "auto" | "basic" | "digest";
}

export interface ConsoleConfig {
  schemaVersion: 1;
  selectedCameraId: string | null;
}

export interface SchedulerConfig {
  schemaVersion: 1;
  minIntervalMs: number;
  maxIntervalMs: number;
  overlapPolicy: "drop";
}

export interface VideoConfig {
  schemaVersion: 1;
  framesPerSecond: number;
  maxOutstandingInferences: number;
}

export interface MediaConfig {
  schemaVersion: 1;
  root: string | null;
  maxAgeDays: number;
  maxFiles: number;
  maxBytes: number;
}

export interface ArtifactConfig {
  schemaVersion: 1;
  root: string | null;
}

export interface AppConfig {
  runtime: RuntimeConfig;
  inference: InferenceConfig;
  camera: CameraDefaults;
  console: ConsoleConfig;
  scheduler: SchedulerConfig;
  video: VideoConfig;
  media: MediaConfig;
  artifacts: ArtifactConfig;
}

export interface AppConfigOverrides {
  runtime?: Partial<RuntimeConfig>;
  inference?: Partial<InferenceConfig>;
  camera?: Partial<CameraDefaults>;
  console?: Partial<ConsoleConfig>;
  scheduler?: Partial<SchedulerConfig>;
  video?: Partial<VideoConfig>;
  media?: Partial<MediaConfig>;
  artifacts?: Partial<ArtifactConfig>;
}

export class AppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppConfigError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AppConfigError(`${path} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new AppConfigError(`${path} contains unsupported field(s): ${extras.join(", ")}.`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AppConfigError(`${path} must be a non-empty string.`);
  return value.trim();
}

function nullableText(value: unknown, path: string): string | null {
  if (value === null) return null;
  return text(value, path);
}

function nullableAbsolutePath(value: unknown, path: string): string | null {
  const normalized = nullableText(value, path);
  if (normalized !== null && !isAbsolute(normalized)) throw new AppConfigError(`${path} must be an absolute path when configured.`);
  return normalized;
}

function integer(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < min || value > max) throw new AppConfigError(`${path} must be an integer from ${min} to ${max}.`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new AppConfigError(`${path} must be a boolean.`);
  return value;
}

function literal<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) throw new AppConfigError(`${path} must be one of: ${options.join(", ")}.`);
  return value as T;
}

function version(value: unknown, path: string): 1 {
  if (value !== 1) throw new AppConfigError(`${path} must be schema version 1.`);
  return 1;
}

export function parseAppConfig(input: unknown): AppConfig {
  const root = record(input, "config");
  exactKeys(root, ["runtime", "inference", "camera", "console", "scheduler", "video", "media", "artifacts"], "config");

  const runtime = record(root.runtime, "runtime");
  exactKeys(runtime, ["schemaVersion", "host", "port", "openBrowser", "dataRoot", "camsnapExecutable", "ffmpegExecutable"], "runtime");
  const inference = record(root.inference, "inference");
  exactKeys(inference, ["schemaVersion", "provider", "model", "timeoutMs", "maxAttempts", "maxRequestsPerSecond"], "inference");
  const camera = record(root.camera, "camera");
  exactKeys(camera, ["schemaVersion", "protocol", "stream", "transport", "rtspClient", "rtspAuth"], "camera");
  const consoleConfig = record(root.console, "console");
  exactKeys(consoleConfig, ["schemaVersion", "selectedCameraId"], "console");
  const scheduler = record(root.scheduler, "scheduler");
  exactKeys(scheduler, ["schemaVersion", "minIntervalMs", "maxIntervalMs", "overlapPolicy"], "scheduler");
  const video = record(root.video, "video");
  exactKeys(video, ["schemaVersion", "framesPerSecond", "maxOutstandingInferences"], "video");
  const media = record(root.media, "media");
  exactKeys(media, ["schemaVersion", "root", "maxAgeDays", "maxFiles", "maxBytes"], "media");
  const artifacts = record(root.artifacts, "artifacts");
  exactKeys(artifacts, ["schemaVersion", "root"], "artifacts");

  const parsed: AppConfig = {
    runtime: {
      schemaVersion: version(runtime.schemaVersion, "runtime.schemaVersion"),
      host: text(runtime.host, "runtime.host"),
      port: integer(runtime.port, "runtime.port", 1, 65_535),
      openBrowser: bool(runtime.openBrowser, "runtime.openBrowser"),
      dataRoot: nullableAbsolutePath(runtime.dataRoot, "runtime.dataRoot"),
      camsnapExecutable: text(runtime.camsnapExecutable, "runtime.camsnapExecutable"),
      ffmpegExecutable: text(runtime.ffmpegExecutable, "runtime.ffmpegExecutable")
    },
    inference: {
      schemaVersion: version(inference.schemaVersion, "inference.schemaVersion"),
      provider: literal(inference.provider, ["moondream"] as const, "inference.provider"),
      model: text(inference.model, "inference.model"),
      timeoutMs: integer(inference.timeoutMs, "inference.timeoutMs", 1_000, 120_000),
      maxAttempts: integer(inference.maxAttempts, "inference.maxAttempts", 1, 5),
      maxRequestsPerSecond: integer(inference.maxRequestsPerSecond, "inference.maxRequestsPerSecond", 1, 100)
    },
    camera: {
      schemaVersion: version(camera.schemaVersion, "camera.schemaVersion"),
      protocol: literal(camera.protocol, ["rtsp", "rtsps"] as const, "camera.protocol"),
      stream: literal(camera.stream, ["stream1", "stream2"] as const, "camera.stream"),
      transport: literal(camera.transport, ["tcp", "udp"] as const, "camera.transport"),
      rtspClient: literal(camera.rtspClient, ["gortsplib", "ffmpeg"] as const, "camera.rtspClient"),
      rtspAuth: literal(camera.rtspAuth, ["auto", "basic", "digest"] as const, "camera.rtspAuth")
    },
    console: {
      schemaVersion: version(consoleConfig.schemaVersion, "console.schemaVersion"),
      selectedCameraId: nullableText(consoleConfig.selectedCameraId, "console.selectedCameraId")
    },
    scheduler: {
      schemaVersion: version(scheduler.schemaVersion, "scheduler.schemaVersion"),
      minIntervalMs: integer(scheduler.minIntervalMs, "scheduler.minIntervalMs", 1_000),
      maxIntervalMs: integer(scheduler.maxIntervalMs, "scheduler.maxIntervalMs", 1_000),
      overlapPolicy: literal(scheduler.overlapPolicy, ["drop"] as const, "scheduler.overlapPolicy")
    },
    video: {
      schemaVersion: version(video.schemaVersion, "video.schemaVersion"),
      framesPerSecond: integer(video.framesPerSecond, "video.framesPerSecond", 4, 8),
      maxOutstandingInferences: integer(video.maxOutstandingInferences, "video.maxOutstandingInferences", 1, 8)
    },
    media: {
      schemaVersion: version(media.schemaVersion, "media.schemaVersion"),
      root: nullableText(media.root, "media.root"),
      maxAgeDays: integer(media.maxAgeDays, "media.maxAgeDays", 1),
      maxFiles: integer(media.maxFiles, "media.maxFiles", 1),
      maxBytes: integer(media.maxBytes, "media.maxBytes", 1_048_576)
    },
    artifacts: {
      schemaVersion: version(artifacts.schemaVersion, "artifacts.schemaVersion"),
      root: nullableAbsolutePath(artifacts.root, "artifacts.root")
    }
  };

  if (parsed.scheduler.minIntervalMs > parsed.scheduler.maxIntervalMs) throw new AppConfigError("scheduler.minIntervalMs must not exceed scheduler.maxIntervalMs.");
  return parsed;
}
