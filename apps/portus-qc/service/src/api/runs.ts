import type { IncomingMessage, ServerResponse } from "node:http";
import { InspectionRunError, type InspectionRunService } from "../domain/inspection-runs";
import type { ResultService } from "../domain/results";
import { HttpRequestError, readBinaryBody, readJsonBody, sendJson } from "./http";

function runInput(value: unknown): { cameraId: string; inspectionId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpRequestError(400, "run_invalid", "Run body must be an object.");
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "cameraId" && key !== "inspectionId");
  if (extra.length > 0) throw new HttpRequestError(400, "run_invalid", `Run body contains unsupported field(s): ${extra.join(", ")}.`);
  if (typeof record.cameraId !== "string" || !record.cameraId.trim()) throw new HttpRequestError(400, "run_invalid", "cameraId must be a non-empty string.");
  if (typeof record.inspectionId !== "string" || !record.inspectionId.trim()) throw new HttpRequestError(400, "run_invalid", "inspectionId must be a non-empty string.");
  return { cameraId: record.cameraId.trim(), inspectionId: record.inspectionId.trim() };
}

const MAX_FILE_UPLOAD_BYTES = 50 * 1024 * 1024;

function decodedHeader(request: IncomingMessage, name: string, required: boolean): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") {
    if (required) throw new HttpRequestError(400, "run_invalid", `${name} header is required.`);
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(value).trim();
    if (!decoded && required) throw new HttpRequestError(400, "run_invalid", `${name} header must not be empty.`);
    return decoded || undefined;
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(400, "run_invalid", `${name} header is invalid.`);
  }
}

function captureId(pathname: string): string | undefined {
  const match = /^\/api\/runs\/([^/]+)\/process$/u.exec(pathname);
  if (!match?.[1]) return undefined;
  try { return decodeURIComponent(match[1]); }
  catch { throw new HttpRequestError(400, "invalid_path", "Capture id path segment is invalid."); }
}

function status(error: InspectionRunError): number {
  if (error.code === "inspection_not_found" || error.code === "camera_not_found" || error.code === "capture_not_found") return 404;
  if (error.code === "file_invalid") return 400;
  if (error.code === "inspection_disabled" || error.code === "result_conflict") return 409;
  if (error.code === "moondream_not_configured") return 503;
  if (error.code === "camera_failed" || error.code === "provider_failed") return 502;
  if (error.code === "media_failed" || error.code === "persistence_failed") return 500;
  return 500;
}

function sendCapture(response: ServerResponse, capture: Awaited<ReturnType<InspectionRunService["captureOnDemand"]>>): void {
  sendJson(response, 201, { captureId: capture.id });
}

function sendCompleted(
  response: ServerResponse,
  run: Awaited<ReturnType<InspectionRunService["processCaptured"]>>,
  results: ResultService
): void {
  sendJson(response, 201, {
    status: run.status,
    result: results.view(run.result),
    artifact: run.artifact,
    warnings: run.warnings
  });
}

export async function routeRuns(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  runs: InspectionRunService | undefined,
  results: ResultService | undefined
): Promise<boolean> {
  const processId = captureId(pathname);
  if (pathname !== "/api/runs/on-demand" && pathname !== "/api/runs/capture" && pathname !== "/api/runs/file" && processId === undefined) return false;
  if (!runs || !results) {
    sendJson(response, 503, { error: { code: "runs_unavailable", message: "Inspection execution services are not initialized." } });
    return true;
  }
  const method = request.method ?? "GET";
  if (method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { error: { code: "method_not_allowed", message: "Allowed methods: POST." } });
    return true;
  }

  try {
    if (pathname === "/api/runs/file") {
      const inspectionId = decodedHeader(request, "x-portus-qc-inspection-id", true)!;
      const filename = decodedHeader(request, "x-portus-qc-file-name", false) ?? "selected-image";
      const file = await readBinaryBody(request, {
        maxBytes: MAX_FILE_UPLOAD_BYTES,
        allowedContentTypes: ["image/jpeg", "image/png"]
      });
      sendCapture(response, await runs.captureFile({
        inspectionId,
        filename,
        mimeType: file.mimeType as "image/jpeg" | "image/png",
        bytes: file.bytes
      }));
      return true;
    }
    if (pathname === "/api/runs/capture") {
      sendCapture(response, await runs.captureOnDemand(runInput(await readJsonBody(request))));
      return true;
    }
    if (processId !== undefined) {
      sendCompleted(response, await runs.processCaptured(processId), results);
      return true;
    }
    const run = await runs.runOnDemand(runInput(await readJsonBody(request)));
    sendCompleted(response, run, results);
    return true;
  } catch (error) {
    if (error instanceof HttpRequestError) {
      sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
      return true;
    }
    if (error instanceof InspectionRunError) {
      sendJson(response, status(error), { error: { code: `run_${error.code}`, message: error.message } });
      return true;
    }
    throw error;
  }
}
