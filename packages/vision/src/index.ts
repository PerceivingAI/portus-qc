import type {
  BoxGeometry,
  VisionCapability,
  VisionProvider,
  VisionRequest,
  VisionResponse,
  VisionResult
} from "@portus-qc/contracts";

import type { RequestGate } from "./request-gate";

export { FixedIntervalRequestGate } from "./request-gate";
export type { FixedIntervalRequestGateOptions, RequestGate } from "./request-gate";
export { MoondreamVisualClassifier, VisualClassifierError } from "./classifier";
export type { MoondreamVisualClassifierOptions } from "./classifier";

export interface MoondreamProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  requestGate?: RequestGate;
}

type MoondreamJson = Record<string, unknown>;
const MOONDREAM_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MOONDREAM_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function bodyFor(request: VisionRequest, model: string): MoondreamJson {
  const common = { model, image_url: bytesToDataUrl(request.image.bytes, request.image.mimeType) };
  switch (request.capability) {
    case "query": return { ...common, question: request.prompt };
    case "detect":
    case "point":
    case "segment": return { ...common, object: request.prompt };
    case "caption": return { ...common, length: "normal", stream: false };
  }
}

function numericMetrics(payload: unknown): Record<string, number> | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const metrics = (payload as Record<string, unknown>).metrics;
  if (metrics === null || typeof metrics !== "object") return undefined;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  }
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 2_000);
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function aborted(error: unknown, signal: AbortSignal): boolean { return signal.aborted || error instanceof Error && error.name === "AbortError"; }

export class VisionProviderError extends Error {
  constructor(
    readonly code: "unsupported_capability" | "unsupported_media" | "media_too_large" | "request_failed" | "invalid_response" | "timeout",
    message: string,
    readonly status?: number,
    readonly providerCode?: string,
    readonly recoverable = false,
    readonly attempts = 1
  ) {
    super(message);
    this.name = "VisionProviderError";
  }
}

function providerCodeFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const errorRecord = (payload as Record<string, unknown>).error;
  if (!errorRecord || typeof errorRecord !== "object") return undefined;
  const code = (errorRecord as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizedCoordinate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function normalizedBox(value: unknown): BoxGeometry | undefined {
  const item = record(value);
  if (!item) return undefined;
  const xMin = normalizedCoordinate(item.x_min);
  const yMin = normalizedCoordinate(item.y_min);
  const xMax = normalizedCoordinate(item.x_max);
  const yMax = normalizedCoordinate(item.y_max);
  if (xMin === undefined || yMin === undefined || xMax === undefined || yMax === undefined) return undefined;
  if (xMin >= xMax || yMin >= yMax) return undefined;
  return { xMin, yMin, xMax, yMax };
}

function invalidNativeResponse(capability: VisionCapability, status: number, attempt: number, detail: string): never {
  throw new VisionProviderError("invalid_response", `Moondream ${capability} response is invalid: ${detail}.`, status, undefined, false, attempt);
}

function normalizeNativeResult(capability: VisionCapability, payload: unknown, status: number, attempt: number): VisionResult {
  const native = record(payload);
  if (!native) return invalidNativeResponse(capability, status, attempt, "expected an object");

  if (capability === "query") {
    const text = typeof native.answer === "string" ? native.answer.trim() : "";
    if (!text) return invalidNativeResponse(capability, status, attempt, "answer must be a non-empty string");
    return { capability, text };
  }

  if (capability === "caption") {
    const text = typeof native.caption === "string" ? native.caption.trim() : "";
    if (!text) return invalidNativeResponse(capability, status, attempt, "caption must be a non-empty string");
    return { capability, text };
  }

  if (capability === "detect") {
    if (!Array.isArray(native.objects)) return invalidNativeResponse(capability, status, attempt, "objects must be an array");
    const boxes: BoxGeometry[] = [];
    for (const item of native.objects) {
      const box = normalizedBox(item);
      if (!box) return invalidNativeResponse(capability, status, attempt, "every object must contain normalized x_min/y_min/x_max/y_max coordinates");
      boxes.push(box);
    }
    return { capability, boxes };
  }

  if (capability === "point") {
    if (!Array.isArray(native.points)) return invalidNativeResponse(capability, status, attempt, "points must be an array");
    const points = native.points.map((item) => {
      const point = record(item);
      const x = normalizedCoordinate(point?.x);
      const y = normalizedCoordinate(point?.y);
      if (x === undefined || y === undefined) return invalidNativeResponse(capability, status, attempt, "every point must contain normalized x/y coordinates");
      return { x, y };
    });
    return { capability, points };
  }

  const path = typeof native.path === "string" ? native.path.trim() : "";
  if (!path) return invalidNativeResponse(capability, status, attempt, "path must be a non-empty SVG path string");
  const bbox = normalizedBox(native.bbox);
  if (!bbox) return invalidNativeResponse(capability, status, attempt, "bbox must contain normalized x_min/y_min/x_max/y_max coordinates");
  return { capability, regions: [{ path, bbox }] };
}

export class MoondreamVisionProvider implements VisionProvider {
  readonly id = "moondream";
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #requestGate: RequestGate | undefined;
  readonly #capabilities = new Set<VisionCapability>(["query", "caption", "detect", "point", "segment"]);

  constructor(options: MoondreamProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("Moondream API key is required.");
    if (!options.model.trim()) throw new Error("Moondream model is required.");
    this.#apiKey = options.apiKey;
    this.model = options.model;
    this.#baseUrl = (options.baseUrl ?? "https://api.moondream.ai/v1").replace(/\/$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#requestGate = options.requestGate;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new Error("Moondream timeoutMs must be a positive integer.");
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts <= 0 || this.#maxAttempts > 5) throw new Error("Moondream maxAttempts must be an integer from 1 to 5.");
  }

  supports(capability: VisionCapability): boolean { return this.#capabilities.has(capability); }

  async execute(request: VisionRequest): Promise<VisionResponse> {
    if (!this.supports(request.capability)) throw new VisionProviderError("unsupported_capability", `Unsupported capability: ${request.capability}`);
    if (!MOONDREAM_IMAGE_TYPES.has(request.image.mimeType)) throw new VisionProviderError("unsupported_media", `Moondream direct API requires JPEG or PNG input; received ${request.image.mimeType}.`, 415);
    if (request.image.bytes.byteLength > MOONDREAM_MAX_IMAGE_BYTES) throw new VisionProviderError("media_too_large", "Moondream image exceeds the documented 10 MB limit.", 413);

    const started = performance.now();
    let lastStatus: number | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      await this.#requestGate?.acquire();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      let response: Response;
      let payload: unknown;
      let parsed = true;
      try {
        response = await this.#fetch(`${this.#baseUrl}/${request.capability}`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Moondream-Auth": this.#apiKey },
          body: JSON.stringify(bodyFor(request, this.model)),
          signal: controller.signal
        });
        lastStatus = response.status;
        try { payload = await response.json(); }
        catch (error) {
          if (aborted(error, controller.signal)) throw error;
          parsed = false;
          payload = undefined;
        }
      } catch (error) {
        clearTimeout(timeout);
        const timedOut = aborted(error, controller.signal);
        if (attempt < this.#maxAttempts) {
          await sleep(Math.min(250 * 2 ** (attempt - 1), 2_000));
          continue;
        }
        if (timedOut) throw new VisionProviderError("timeout", "Moondream request timed out.", 504, undefined, true, attempt);
        throw new VisionProviderError("request_failed", "Moondream request failed before receiving a complete response.", undefined, undefined, true, attempt);
      }
      clearTimeout(timeout);

      if (!response.ok) {
        if (retryable(response.status) && attempt < this.#maxAttempts) {
          await sleep(retryDelayMs(response, attempt));
          continue;
        }
        throw new VisionProviderError(
          "request_failed",
          `Moondream request failed with HTTP ${response.status}.`,
          response.status,
          providerCodeFromPayload(payload),
          retryable(response.status),
          attempt
        );
      }

      if (!parsed || payload === null || typeof payload !== "object") {
        throw new VisionProviderError("invalid_response", "Moondream returned an invalid JSON response.", response.status, undefined, false, attempt);
      }
      const native = payload as Record<string, unknown>;
      const result = normalizeNativeResult(request.capability, payload, response.status, attempt);
      const requestId = typeof native.request_id === "string" ? native.request_id : undefined;
      const usage = numericMetrics(payload);
      return {
        capability: result.capability,
        result,
        provider: this.id,
        model: this.model,
        ...(requestId ? { requestId } : {}),
        durationMs: Math.max(0, performance.now() - started),
        ...(usage ? { usage } : {})
      };
    }
    throw new VisionProviderError("request_failed", `Moondream request failed with HTTP ${lastStatus ?? "unknown"}.`, lastStatus, undefined, lastStatus !== undefined && retryable(lastStatus), this.#maxAttempts);
  }
}
