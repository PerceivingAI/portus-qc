import type { IncomingMessage, ServerResponse } from "node:http";
import { CameraDomainError, type CameraService } from "../domain/cameras";
import { HttpRequestError, readJsonBody, sendJson } from "./http";

const CONSOLE_SECRET_HEADER = "x-portus-qc-console-secret";

function requireConsoleSecretRequest(request: IncomingMessage): void {
  if (request.headers[CONSOLE_SECRET_HEADER] !== "1") {
    throw new HttpRequestError(403, "console_secret_request_required", "Camera credential retrieval is available only to the local Portus QC Console.");
  }
}

function decodeSegment(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new HttpRequestError(400, "invalid_path", "Camera id path segment is invalid."); }
}

function routeShape(pathname: string): { id?: string; action?: "test" | "preview" | "slot" | "selection" | "credentials" } | undefined {
  if (pathname === "/api/cameras") return {};
  if (pathname === "/api/cameras/_actions/test" || pathname === "/api/cameras/_actions/discover" || pathname === "/api/cameras/_actions/connect") return {};
  if (pathname === "/api/cameras/_actions/selection") return { action: "selection" };
  const action = /^\/api\/cameras\/([^/]+)\/(test|preview|slot|credentials)$/u.exec(pathname);
  if (action?.[1] && action[2]) return { id: decodeSegment(action[1]), action: action[2] as "test" | "preview" | "slot" | "credentials" };
  const item = /^\/api\/cameras\/([^/]+)$/u.exec(pathname);
  if (item?.[1]) return { id: decodeSegment(item[1]) };
  return undefined;
}

function status(error: CameraDomainError): number {
  if (error.code === "not_found") return 404;
  if (error.code === "conflict") return 409;
  if (error.code === "runtime_unavailable") return 503;
  if (error.code === "operation_failed") return 502;
  return 400;
}

function slotFromBody(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpRequestError(400, "camera_slot_invalid", "Camera slot body must be an object.");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "slot")) throw new HttpRequestError(400, "camera_slot_invalid", "Camera slot body accepts only the slot field.");
  return record.slot;
}

async function sendPreview(response: ServerResponse, service: CameraService, cameraId: string): Promise<void> {
  const image = await service.snapshot(cameraId);
  const bytes = Buffer.from(image.bytes);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": bytes.byteLength,
    "content-type": image.mimeType,
    "x-content-type-options": "nosniff"
  });
  response.end(bytes);
}

export async function routeCameras(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  service: CameraService | undefined
): Promise<boolean> {
  if (pathname !== "/api/cameras" && !pathname.startsWith("/api/cameras/")) return false;
  if (!service) {
    sendJson(response, 503, { error: { code: "cameras_unavailable", message: "Camera services are not initialized." } });
    return true;
  }
  const shape = routeShape(pathname);
  if (!shape) {
    sendJson(response, 404, { error: { code: "not_found", message: "Route not found." } });
    return true;
  }
  const method = request.method ?? "GET";

  try {
    if (pathname === "/api/cameras" && method === "GET") {
      sendJson(response, 200, { cameras: await service.list() });
      return true;
    }
    if (pathname === "/api/cameras/_actions/selection" && method === "GET") {
      sendJson(response, 200, { cameraId: await service.selectedId() ?? null });
      return true;
    }
    if (pathname === "/api/cameras/_actions/selection" && method === "PUT") {
      const input = await readJsonBody(request);
      if (!input || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, "cameraId") || Object.keys(input).length !== 1) throw new HttpRequestError(400, "camera_selection_invalid", "Camera selection body accepts only cameraId.");
      const cameraIdValue = "cameraId" in input ? input.cameraId : undefined;
      if (cameraIdValue !== null && typeof cameraIdValue !== "string") throw new HttpRequestError(400, "camera_selection_invalid", "cameraId must be a string or null.");
      await service.select(cameraIdValue ?? undefined);
      sendJson(response, 200, { cameraId: await service.selectedId() ?? null });
      return true;
    }
    if (pathname === "/api/cameras/_actions/connect" && method === "POST") {
      const camera = await service.connect(await readJsonBody(request));
      response.setHeader("location", `/api/cameras/${encodeURIComponent(camera.id)}`);
      sendJson(response, 201, { camera });
      return true;
    }
    if (pathname === "/api/cameras/_actions/test" && method === "POST") {
      sendJson(response, 200, { probe: await service.testDraft(await readJsonBody(request)) });
      return true;
    }
    if (pathname === "/api/cameras/_actions/discover" && method === "POST") {
      sendJson(response, 200, { cameras: await service.discover() });
      return true;
    }
    if (shape.id && shape.action === "credentials" && method === "GET") {
      requireConsoleSecretRequest(request);
      sendJson(response, 200, { credentials: await service.credentials(shape.id) });
      return true;
    }
    if (shape.id && shape.action === "test" && method === "POST") {
      sendJson(response, 200, { probe: await service.test(shape.id) });
      return true;
    }
    if (shape.id && shape.action === "preview" && method === "POST") {
      await sendPreview(response, service, shape.id);
      return true;
    }
    if (shape.id && shape.action === "slot" && method === "PUT") {
      sendJson(response, 200, { camera: await service.move(shape.id, slotFromBody(await readJsonBody(request))) });
      return true;
    }
    if (shape.id && !shape.action && method === "GET") {
      sendJson(response, 200, { camera: await service.get(shape.id) });
      return true;
    }
    if (shape.id && !shape.action && method === "PUT") {
      sendJson(response, 200, { camera: await service.replace(shape.id, await readJsonBody(request)) });
      return true;
    }
    if (shape.id && !shape.action && method === "DELETE") {
      await service.delete(shape.id);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return true;
    }

    let allow = "GET";
    if (pathname === "/api/cameras/_actions/selection") allow = method === "GET" ? "GET, PUT" : "GET, PUT";
    else if (pathname === "/api/cameras/_actions/test" || pathname === "/api/cameras/_actions/discover" || pathname === "/api/cameras/_actions/connect" || shape.action === "test" || shape.action === "preview") allow = "POST";
    else if (shape.action === "credentials") allow = "GET";
    else if (shape.action === "slot") allow = "PUT";
    else if (shape.id) allow = "GET, PUT, DELETE";
    response.setHeader("allow", allow);
    sendJson(response, 405, { error: { code: "method_not_allowed", message: `Allowed methods: ${allow}.` } });
    return true;
  } catch (error) {
    if (error instanceof HttpRequestError) {
      sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
      return true;
    }
    if (error instanceof CameraDomainError) {
      sendJson(response, status(error), {
        error: {
          code: `camera_${error.code}`,
          message: error.message,
          ...(error.reason ? { reason: error.reason } : {})
        }
      });
      return true;
    }
    throw error;
  }
}
