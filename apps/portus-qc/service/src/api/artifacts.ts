import type { IncomingMessage, ServerResponse } from "node:http";
import { FolderPickerUnavailableError } from "../runtime/folder-picker";
import { ArtifactServiceError, type ArtifactService } from "../domain/artifacts";
import { HttpRequestError, readJsonBody, sendJson } from "./http";

function resultId(pathname: string): string | undefined {
  const match = /^\/api\/artifacts\/export\/([^/]+)$/u.exec(pathname);
  if (!match?.[1]) return undefined;
  try { return decodeURIComponent(match[1]); }
  catch { throw new HttpRequestError(400, "invalid_path", "Result id path segment is invalid."); }
}

function rootFromBody(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpRequestError(400, "artifact_settings_invalid", "Artifact settings body must be an object.");
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "root") throw new HttpRequestError(400, "artifact_settings_invalid", "Artifact settings accepts only the root field.");
  if (record.root !== null && typeof record.root !== "string") throw new HttpRequestError(400, "artifact_settings_invalid", "Artifact root must be an absolute path string or null for the default Downloads folder.");
  return record.root as string | null;
}

export async function routeArtifacts(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  service: ArtifactService | undefined
): Promise<boolean> {
  if (!pathname.startsWith("/api/artifacts")) return false;
  if (!service) {
    sendJson(response, 503, { error: { code: "artifacts_unavailable", message: "Artifact services are not initialized." } });
    return true;
  }
  const method = request.method ?? "GET";
  const exportId = resultId(pathname);

  try {
    if (pathname === "/api/artifacts/settings" && method === "GET") {
      sendJson(response, 200, { artifacts: service.settings() });
      return true;
    }
    if (pathname === "/api/artifacts/settings" && method === "PUT") {
      sendJson(response, 200, { artifacts: await service.setRoot(rootFromBody(await readJsonBody(request))) });
      return true;
    }
    if (pathname === "/api/artifacts/pick-folder" && method === "POST") {
      sendJson(response, 200, await service.pickRoot());
      return true;
    }
    if (exportId !== undefined && method === "POST") {
      sendJson(response, 200, { artifact: await service.exportResult(exportId) });
      return true;
    }

    const known = pathname === "/api/artifacts/settings" || pathname === "/api/artifacts/pick-folder" || exportId !== undefined;
    if (known) {
      const allow = pathname === "/api/artifacts/settings" ? "GET, PUT" : "POST";
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
    if (error instanceof FolderPickerUnavailableError) {
      sendJson(response, 503, { error: { code: "folder_picker_unavailable", message: error.message } });
      return true;
    }
    if (error instanceof ArtifactServiceError) {
      const status = error.code === "invalid_root" ? 400 : error.code === "result_not_found" ? 404 : 409;
      sendJson(response, status, { error: { code: `artifact_${error.code}`, message: error.message } });
      return true;
    }
    throw error;
  }
}
