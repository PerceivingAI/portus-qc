import type { IncomingMessage, ServerResponse } from "node:http";
import { MoondreamSettingsError, type MoondreamSettingsService, type MoondreamSettingsUpdate } from "../domain/moondream-settings";
import { HttpRequestError, readJsonBody, sendJson } from "./http";

const CONSOLE_SECRET_HEADER = "x-portus-qc-console-secret";

function settingsUpdate(input: unknown): MoondreamSettingsUpdate {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpRequestError(400, "moondream_settings_invalid", "Moondream settings body must be an object.");
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "apiKey" || keys[1] !== "model" || typeof record.apiKey !== "string" || typeof record.model !== "string") {
    throw new HttpRequestError(400, "moondream_settings_invalid", "Moondream settings body accepts exactly the apiKey and model string fields.");
  }
  return { apiKey: record.apiKey, model: record.model };
}

function requireConsoleSecretRequest(request: IncomingMessage): void {
  if (request.headers[CONSOLE_SECRET_HEADER] !== "1") {
    throw new HttpRequestError(403, "console_secret_request_required", "API-key retrieval is available only to the local Portus QC Console.");
  }
}

export async function routeMoondreamSettings(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  service: MoondreamSettingsService | undefined
): Promise<boolean> {
  if (!pathname.startsWith("/api/inference/moondream")) return false;
  if (!service) {
    sendJson(response, 503, { error: { code: "moondream_settings_unavailable", message: "Moondream settings services are not initialized." } });
    return true;
  }

  const method = request.method ?? "GET";
  try {
    if (pathname === "/api/inference/moondream" && method === "GET") {
      sendJson(response, 200, { moondream: await service.settings() });
      return true;
    }
    if (pathname === "/api/inference/moondream" && method === "PUT") {
      sendJson(response, 200, { moondream: await service.save(settingsUpdate(await readJsonBody(request))) });
      return true;
    }
    if (pathname === "/api/inference/moondream/key" && method === "GET") {
      requireConsoleSecretRequest(request);
      sendJson(response, 200, { apiKey: await service.apiKey() });
      return true;
    }

    if (pathname === "/api/inference/moondream" || pathname === "/api/inference/moondream/key") {
      const allow = pathname === "/api/inference/moondream" ? "GET, PUT" : "GET";
      response.setHeader("allow", allow);
      sendJson(response, 405, { error: { code: "method_not_allowed", message: `Allowed methods: ${allow}.` } });
      return true;
    }
    sendJson(response, 404, { error: { code: "not_found", message: "Route not found." } });
    return true;
  } catch (error) {
    if (error instanceof HttpRequestError) {
      sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
      return true;
    }
    if (error instanceof MoondreamSettingsError) {
      sendJson(response, 400, { error: { code: `moondream_${error.code}`, message: error.message } });
      return true;
    }
    throw error;
  }
}
