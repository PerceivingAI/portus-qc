import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_MAX_JSON_BYTES = 64 * 1024;

export class HttpRequestError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "HttpRequestError";
  }
}

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8"
  });
  response.end(payload);
}

export function sendHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "text/html; charset=utf-8"
  });
  response.end(body);
}

export function rejectCrossOriginMutation(request: IncomingMessage, response: ServerResponse): boolean {
  const method = request.method ?? "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const origin = request.headers.origin;
  if (!origin) return false;
  const host = request.headers.host;
  let sameOrigin = false;
  try {
    const parsed = new URL(origin);
    sameOrigin = parsed.protocol === "http:" && typeof host === "string" && parsed.host === host;
  } catch {
    sameOrigin = false;
  }
  if (sameOrigin) return false;
  sendJson(response, 403, { error: { code: "cross_origin_forbidden", message: "Browser-originated mutations must come from the Portus QC local origin." } });
  return true;
}

export async function readBinaryBody(
  request: IncomingMessage,
  options: { maxBytes: number; allowedContentTypes: readonly string[] }
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !options.allowedContentTypes.includes(contentType)) {
    throw new HttpRequestError(415, "unsupported_media_type", `Request body must use one of: ${options.allowedContentTypes.join(", ")}.`);
  }
  if (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0) throw new Error("Binary body maxBytes must be a positive integer.");

  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (!Number.isInteger(parsed) || parsed < 0) throw new HttpRequestError(400, "invalid_content_length", "Content-Length must be a non-negative integer.");
    if (parsed > options.maxBytes) throw new HttpRequestError(413, "payload_too_large", `Request body must not exceed ${options.maxBytes} bytes.`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > options.maxBytes) throw new HttpRequestError(413, "payload_too_large", `Request body must not exceed ${options.maxBytes} bytes.`);
    chunks.push(bytes);
  }
  if (total === 0) throw new HttpRequestError(400, "empty_body", "Request body is required.");
  return { bytes: new Uint8Array(Buffer.concat(chunks)), mimeType: contentType };
}

export async function readJsonBody(request: IncomingMessage, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpRequestError(415, "unsupported_media_type", "Request body must use application/json.");

  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (!Number.isInteger(parsed) || parsed < 0) throw new HttpRequestError(400, "invalid_content_length", "Content-Length must be a non-negative integer.");
    if (parsed > maxBytes) throw new HttpRequestError(413, "payload_too_large", `JSON request body must not exceed ${maxBytes} bytes.`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw new HttpRequestError(413, "payload_too_large", `JSON request body must not exceed ${maxBytes} bytes.`);
    chunks.push(bytes);
  }
  if (total === 0) throw new HttpRequestError(400, "empty_body", "JSON request body is required.");

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpRequestError(400, "invalid_json", "Request body must contain valid JSON.");
  }
}
