import type {
  CalibrationClassifierLabel,
  VisualClassificationRequest,
  VisualClassificationResponse,
  VisualClassifier
} from "@portus-qc/contracts";
import type { RequestGate } from "./request-gate";

const MOONDREAM_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MOONDREAM_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

export interface MoondreamVisualClassifierOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  requestGate?: RequestGate;
  maxCompletionTokens?: number;
}

export class VisualClassifierError extends Error {
  constructor(
    readonly code: "unsupported_media" | "media_too_large" | "request_failed" | "invalid_response" | "timeout",
    message: string,
    readonly status?: number,
    readonly providerCode?: string,
    readonly recoverable = false,
    readonly attempts = 1
  ) {
    super(message);
    this.name = "VisualClassifierError";
  }
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function providerCodeFromPayload(payload: unknown): string | undefined {
  const errorRecord = record(record(payload)?.error);
  return typeof errorRecord?.code === "string" ? errorRecord.code : undefined;
}

function numericUsage(payload: unknown): Record<string, number> | undefined {
  const usage = record(record(payload)?.usage);
  if (!usage) return undefined;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function validatedLabels(labels: readonly CalibrationClassifierLabel[]): readonly CalibrationClassifierLabel[] {
  const unique = [...new Set(labels)];
  if (unique.length === 0) throw new Error("Visual classification requires at least one allowed label.");
  return unique;
}

function normalizedLabel(content: unknown, labels: readonly CalibrationClassifierLabel[]): CalibrationClassifierLabel | undefined {
  if (typeof content !== "string") return undefined;
  const normalized = content.trim().toLowerCase();
  return labels.find((label) => label === normalized);
}

function chatContent(payload: unknown): unknown {
  const choices = record(payload)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  return record(record(choices[0])?.message)?.content;
}

export class MoondreamVisualClassifier implements VisualClassifier {
  readonly id = "moondream";
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #requestGate: RequestGate | undefined;
  readonly #maxCompletionTokens: number;

  constructor(options: MoondreamVisualClassifierOptions) {
    if (!options.apiKey.trim()) throw new Error("Moondream API key is required.");
    if (!options.model.trim()) throw new Error("Moondream model is required.");
    this.#apiKey = options.apiKey;
    this.model = options.model;
    this.#baseUrl = (options.baseUrl ?? "https://api.moondream.ai/v1").replace(/\/$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#requestGate = options.requestGate;
    this.#maxCompletionTokens = options.maxCompletionTokens ?? 256;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new Error("Moondream timeoutMs must be a positive integer.");
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts <= 0 || this.#maxAttempts > 5) throw new Error("Moondream maxAttempts must be an integer from 1 to 5.");
    if (!Number.isInteger(this.#maxCompletionTokens) || this.#maxCompletionTokens < 32 || this.#maxCompletionTokens > 4096) throw new Error("maxCompletionTokens must be an integer from 32 to 4096.");
  }

  async classify(request: VisualClassificationRequest): Promise<VisualClassificationResponse> {
    const labels = validatedLabels(request.labels);
    if (!request.question.trim()) throw new Error("Visual classification question must not be empty.");
    if (!MOONDREAM_IMAGE_TYPES.has(request.image.mimeType)) throw new VisualClassifierError("unsupported_media", `Moondream chat classification requires JPEG or PNG input; received ${request.image.mimeType}.`, 415);
    if (request.image.bytes.byteLength > MOONDREAM_MAX_IMAGE_BYTES) throw new VisualClassifierError("media_too_large", "Moondream image exceeds the documented 10 MB limit.", 413);

    const instruction = `${request.question.trim()}\n\nReply with exactly one of these labels and no other text: ${labels.join(", ")}.`;
    const body = {
      model: this.model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: instruction },
          { type: "image_url", image_url: { url: bytesToDataUrl(request.image.bytes, request.image.mimeType) } }
        ]
      }],
      temperature: 0,
      reasoning: true,
      max_completion_tokens: this.#maxCompletionTokens,
      stream: false
    };

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
        response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
          body: JSON.stringify(body),
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
        if (timedOut) throw new VisualClassifierError("timeout", "Moondream classification request timed out.", 504, undefined, true, attempt);
        throw new VisualClassifierError("request_failed", "Moondream classification request failed before receiving a complete response.", undefined, undefined, true, attempt);
      }
      clearTimeout(timeout);

      if (!response.ok) {
        if (retryable(response.status) && attempt < this.#maxAttempts) {
          await sleep(retryDelayMs(response, attempt));
          continue;
        }
        throw new VisualClassifierError(
          "request_failed",
          `Moondream classification request failed with HTTP ${response.status}.`,
          response.status,
          providerCodeFromPayload(payload),
          retryable(response.status),
          attempt
        );
      }

      if (!parsed || !record(payload)) throw new VisualClassifierError("invalid_response", "Moondream classification returned an invalid JSON response.", response.status, undefined, false, attempt);
      const label = normalizedLabel(chatContent(payload), labels);
      if (!label) throw new VisualClassifierError("invalid_response", "Moondream classification response did not match the allowed vocabulary.", response.status, undefined, false, attempt);
      const native = record(payload)!;
      const requestId = typeof native.id === "string" ? native.id : typeof native.request_id === "string" ? native.request_id : undefined;
      const usage = numericUsage(payload);
      return {
        label,
        provider: this.id,
        model: this.model,
        ...(requestId ? { requestId } : {}),
        durationMs: Math.max(0, performance.now() - started),
        ...(usage ? { usage } : {})
      };
    }
    throw new VisualClassifierError("request_failed", `Moondream classification request failed with HTTP ${lastStatus ?? "unknown"}.`, lastStatus, undefined, lastStatus !== undefined && retryable(lastStatus), this.#maxAttempts);
  }
}
