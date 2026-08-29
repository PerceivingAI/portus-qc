import type { IncomingMessage, ServerResponse } from "node:http";
import { InspectionDomainError, type InspectionService } from "../domain/inspections";
import { HttpRequestError, readJsonBody, sendJson } from "./http";

function domainStatus(error: InspectionDomainError): number {
  if (error.code === "not_found") return 404;
  if (error.code === "conflict" || error.code === "disabled") return 409;
  return 400;
}

function inspectionId(pathname: string): string | undefined {
  const match = /^\/api\/inspections\/([^/]+)$/u.exec(pathname);
  if (!match?.[1]) return undefined;
  try { return decodeURIComponent(match[1]); }
  catch { throw new HttpRequestError(400, "invalid_path", "Inspection id path segment is invalid."); }
}

export async function routeInspections(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  service: InspectionService | undefined
): Promise<boolean> {
  if (pathname !== "/api/inspections" && !pathname.startsWith("/api/inspections/")) return false;
  if (!service) {
    sendJson(response, 503, { error: { code: "inspections_unavailable", message: "Inspection storage is not initialized." } });
    return true;
  }

  const method = request.method ?? "GET";
  const id = pathname === "/api/inspections" ? undefined : inspectionId(pathname);
  if (pathname !== "/api/inspections" && id === undefined) {
    sendJson(response, 404, { error: { code: "not_found", message: "Route not found." } });
    return true;
  }

  try {
    if (method === "GET" && id === undefined) {
      sendJson(response, 200, { inspections: await service.list() });
      return true;
    }
    if (method === "POST" && id === undefined) {
      const inspection = await service.create(await readJsonBody(request));
      response.setHeader("location", `/api/inspections/${encodeURIComponent(inspection.id)}`);
      sendJson(response, 201, { inspection });
      return true;
    }
    if (method === "GET" && id !== undefined) {
      sendJson(response, 200, { inspection: await service.get(id) });
      return true;
    }
    if (method === "PUT" && id !== undefined) {
      sendJson(response, 200, { inspection: await service.replace(id, await readJsonBody(request)) });
      return true;
    }
    if (method === "DELETE" && id !== undefined) {
      await service.delete(id);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return true;
    }

    const allow = id === undefined ? "GET, POST" : "GET, PUT, DELETE";
    response.setHeader("allow", allow);
    sendJson(response, 405, { error: { code: "method_not_allowed", message: `Allowed methods: ${allow}.` } });
    return true;
  } catch (error) {
    if (error instanceof HttpRequestError) {
      sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
      return true;
    }
    if (error instanceof InspectionDomainError) {
      sendJson(response, domainStatus(error), { error: { code: `inspection_${error.code}`, message: error.message } });
      return true;
    }
    throw error;
  }
}
