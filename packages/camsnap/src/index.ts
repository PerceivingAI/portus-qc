import type { InferenceImage, SourceMetadata } from "@portus-qc/contracts";
import { prepareInferenceImage } from "@portus-qc/media";

export interface CamsnapCameraConfig {
  id: string;
  name?: string;
  host: string;
  port?: number;
  protocol?: "rtsp" | "rtsps";
  stream?: "stream1" | "stream2";
  path?: string;
  transport?: "tcp" | "udp";
  rtspClient?: "gortsplib" | "ffmpeg";
  rtspAuth?: "auto" | "basic" | "digest";
}

export interface CamsnapCredentials {
  username: string;
  password: string;
}

export type CamsnapCredentialProvider = (camera: CamsnapCameraConfig) => CamsnapCredentials | Promise<CamsnapCredentials>;

export interface DiscoveredCameraAddress {
  host: string;
  discoveryPort?: number;
}

export interface CamsnapCameraDescriptor extends DiscoveredCameraAddress {
  id: string;
  name: string;
}

export interface CamsnapHealth {
  reachable: boolean;
  checkedAt: string;
  message?: CamsnapOperationalErrorCode;
}

export interface CamsnapClip {
  bytes: Uint8Array;
  mimeType: string;
  source: SourceMetadata;
}

export interface CamsnapAdapterConfig {
  discoveryAttempts: number;
  discoveryTimeoutMs: number;
  snapshotTimeoutMs: number;
  clipTimeoutMs: number;
}

export const camsnapAdapterConfig: CamsnapAdapterConfig = Object.freeze({
  discoveryAttempts: 3,
  discoveryTimeoutMs: 4_000,
  snapshotTimeoutMs: 10_000,
  clipTimeoutMs: 20_000
});

export type CamsnapOperationalErrorCode =
  | "not_found"
  | "unreachable"
  | "auth_invalid"
  | "server_locked"
  | "timeout"
  | "stream_unavailable"
  | "process_failed"
  | "invalid_output";

export function camsnapFailureRecoverable(code: CamsnapOperationalErrorCode): boolean {
  return code === "unreachable" || code === "timeout" || code === "stream_unavailable" || code === "process_failed";
}

export class CamsnapOperationalError extends Error {
  readonly recoverable: boolean;

  constructor(readonly code: CamsnapOperationalErrorCode, message: string) {
    super(message);
    this.name = "CamsnapOperationalError";
    this.recoverable = camsnapFailureRecoverable(code);
  }
}

export function classifyCamsnapFailure(text: string): CamsnapOperationalErrorCode {
  const normalized = text.toLowerCase();
  if (normalized.includes("server is locked") || normalized.includes("locked out") || normalized.includes("too many") && normalized.includes("auth")) return "server_locked";
  if (normalized.includes("(auth)") || normalized.includes("unauthorized") || normalized.includes("401") || normalized.includes("invalid credentials")) return "auth_invalid";
  if (normalized.includes("timed out") || normalized.includes("timeout")) return "timeout";
  if (normalized.includes("connection refused") || normalized.includes("no route to host") || normalized.includes("network is unreachable") || normalized.includes("host is down")) return "unreachable";
  if (normalized.includes("stream") && (normalized.includes("not found") || normalized.includes("unavailable") || normalized.includes("404"))) return "stream_unavailable";
  return "process_failed";
}

function normalizeCamsnapFailure(error: unknown, operation: string): CamsnapOperationalError {
  if (error instanceof CamsnapOperationalError) return error;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = classifyCamsnapFailure(message);
  return new CamsnapOperationalError(code, `${operation} failed (${code}).`);
}

export function parseCamsnapDiscovery(text: string): readonly DiscoveredCameraAddress[] {
  const results = new Map<string, DiscoveredCameraAddress>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.toLowerCase().startsWith("no devices found")) continue;
    const address = line.split("\t", 1)[0]?.trim();
    if (!address) continue;
    const ipv4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/u.exec(address);
    if (!ipv4) continue;
    const octets = ipv4[1]?.split(".").map(Number) ?? [];
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) continue;
    const discoveryPort = ipv4[2] === undefined ? undefined : Number(ipv4[2]);
    if (discoveryPort !== undefined && (!Number.isInteger(discoveryPort) || discoveryPort < 1 || discoveryPort > 65_535)) continue;
    const key = discoveryPort === undefined ? ipv4[1]! : `${ipv4[1]}:${discoveryPort}`;
    results.set(key, discoveryPort === undefined ? { host: ipv4[1]! } : { host: ipv4[1]!, discoveryPort });
  }
  return [...results.values()];
}

export interface CamsnapRuntime {
  discover(input: { timeoutMs: number }): Promise<{ output: string }>;
  probe(camera: CamsnapCameraConfig, input: { timeoutMs: number }): Promise<{ ok: boolean; output: string }>;
  snapshot(camera: CamsnapCameraConfig, input: { timeoutMs: number }): Promise<{ bytes: Uint8Array; mimeType: "image/jpeg"; width: number; height: number; capturedAt: string }>;
  clip(camera: CamsnapCameraConfig, input: { timeoutMs: number; durationMs: number }): Promise<{ bytes: Uint8Array; mimeType: string; capturedAt: string }>;
}

export interface CamsnapCameraAdapterOptions {
  cameras: readonly CamsnapCameraConfig[];
  runtime: CamsnapRuntime;
  config?: Partial<CamsnapAdapterConfig>;
  now?: () => string;
}

export class CamsnapCameraAdapter {
  readonly id = "camsnap";
  readonly #runtime: CamsnapRuntime;
  readonly #config: CamsnapAdapterConfig;
  readonly #cameras = new Map<string, CamsnapCameraConfig>();
  readonly #now: () => string;

  constructor(options: CamsnapCameraAdapterOptions) {
    this.#runtime = options.runtime;
    this.#config = Object.freeze({ ...camsnapAdapterConfig, ...options.config });
    this.#now = options.now ?? (() => new Date().toISOString());
    for (const camera of options.cameras) {
      validateCamsnapCamera(camera);
      if (this.#cameras.has(camera.id)) throw new Error(`Duplicate camera id: ${camera.id}`);
      this.#cameras.set(camera.id, Object.freeze({ ...camera }));
    }
  }

  async discover(): Promise<readonly CamsnapCameraDescriptor[]> {
    const found = new Map<string, CamsnapCameraDescriptor>();
    let lastError: CamsnapOperationalError | undefined;
    for (let attempt = 0; attempt < this.#config.discoveryAttempts; attempt += 1) {
      try {
        const response = await this.#runtime.discover({ timeoutMs: this.#config.discoveryTimeoutMs });
        for (const address of parseCamsnapDiscovery(response.output)) {
          const addressText = address.discoveryPort === undefined ? address.host : `${address.host}:${address.discoveryPort}`;
          found.set(addressText, { id: `discovered:${addressText}`, name: addressText, ...address });
        }
      } catch (error) {
        lastError = normalizeCamsnapFailure(error, "Camera discovery");
        if (!lastError.recoverable) throw lastError;
      }
    }
    if (found.size === 0 && lastError) throw lastError;
    return [...found.values()];
  }

  async health(cameraId: string): Promise<CamsnapHealth> {
    const camera = this.#camera(cameraId);
    try {
      const response = await this.#runtime.probe(camera, { timeoutMs: this.#config.snapshotTimeoutMs });
      if (response.ok) return { reachable: true, checkedAt: this.#now() };
      return { reachable: false, checkedAt: this.#now(), message: classifyCamsnapFailure(response.output) };
    } catch (error) {
      const normalized = normalizeCamsnapFailure(error, "Camera health probe");
      return { reachable: false, checkedAt: this.#now(), message: normalized.code };
    }
  }

  async snapshot(cameraId: string): Promise<InferenceImage> {
    const camera = this.#camera(cameraId);
    let result: Awaited<ReturnType<CamsnapRuntime["snapshot"]>>;
    try {
      result = await this.#runtime.snapshot(camera, { timeoutMs: this.#config.snapshotTimeoutMs });
    } catch (error) {
      throw normalizeCamsnapFailure(error, "Camera snapshot");
    }
    if (result.bytes.byteLength === 0 || result.width <= 0 || result.height <= 0) throw new CamsnapOperationalError("invalid_output", "Camera snapshot output is invalid.");
    return prepareInferenceImage({
      id: `${camera.id}:${result.capturedAt}`,
      bytes: result.bytes,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
      orientationNormalized: true,
      source: { sourceId: camera.id, capturedAt: result.capturedAt, receivedAt: this.#now() }
    });
  }

  async clip(cameraId: string, durationMs: number): Promise<CamsnapClip> {
    if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error("Clip durationMs must be a positive integer.");
    const camera = this.#camera(cameraId);
    let result: Awaited<ReturnType<CamsnapRuntime["clip"]>>;
    try {
      result = await this.#runtime.clip(camera, { timeoutMs: Math.max(this.#config.clipTimeoutMs, durationMs), durationMs });
    } catch (error) {
      throw normalizeCamsnapFailure(error, "Camera clip");
    }
    if (result.bytes.byteLength === 0 || !result.mimeType.trim()) throw new CamsnapOperationalError("invalid_output", "Camera clip output is invalid.");
    return {
      bytes: result.bytes,
      mimeType: result.mimeType,
      source: { sourceId: camera.id, capturedAt: result.capturedAt, receivedAt: this.#now() }
    };
  }

  #camera(cameraId: string): CamsnapCameraConfig {
    const camera = this.#cameras.get(cameraId);
    if (!camera) throw new CamsnapOperationalError("not_found", `Camera ${cameraId} is not configured.`);
    return camera;
  }
}

export function validateCamsnapCamera(camera: CamsnapCameraConfig): void {
  if (!camera || typeof camera !== "object") throw new Error("Camsnap camera configuration is required.");
  if (typeof camera.id !== "string" || !camera.id.trim()) throw new Error("Camsnap camera id is required.");
  if (camera.name !== undefined && (typeof camera.name !== "string" || !camera.name.trim())) throw new Error(`Camera ${camera.id} has an invalid name.`);
  if (typeof camera.host !== "string" || !camera.host.trim()) throw new Error(`Camera ${camera.id} requires a host.`);
  if (camera.port !== undefined && (!Number.isInteger(camera.port) || camera.port < 1 || camera.port > 65_535)) throw new Error(`Camera ${camera.id} has an invalid port.`);
  if (camera.protocol !== undefined && camera.protocol !== "rtsp" && camera.protocol !== "rtsps") throw new Error(`Camera ${camera.id} has an invalid protocol.`);
  if (camera.stream !== undefined && camera.stream !== "stream1" && camera.stream !== "stream2") throw new Error(`Camera ${camera.id} has an invalid stream.`);
  if (camera.path !== undefined && (typeof camera.path !== "string" || !camera.path.trim())) throw new Error(`Camera ${camera.id} has an invalid path.`);
  if (camera.transport !== undefined && camera.transport !== "tcp" && camera.transport !== "udp") throw new Error(`Camera ${camera.id} has an invalid transport.`);
  if (camera.rtspClient !== undefined && camera.rtspClient !== "gortsplib" && camera.rtspClient !== "ffmpeg") throw new Error(`Camera ${camera.id} has an invalid RTSP client.`);
  if (camera.rtspAuth !== undefined && camera.rtspAuth !== "auto" && camera.rtspAuth !== "basic" && camera.rtspAuth !== "digest") throw new Error(`Camera ${camera.id} has an invalid RTSP auth mode.`);
}
