import type { IncomingMessage, ServerResponse } from "node:http";
import { ResultDomainError, type ResultService } from "../domain/results";
import { HttpRequestError, sendJson } from "./http";

function decode(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new HttpRequestError(400, "invalid_path", "Result id path segment is invalid."); }
}

function shape(pathname: string): { kind: "current" } | { kind: "result" | "source"; id: string } | undefined {
  if (pathname === "/api/results/current") return { kind: "current" };
  const source = /^\/api\/results\/([^/]+)\/source$/u.exec(pathname);
  if (source?.[1]) return { kind: "source", id: decode(source[1]) };
  const result = /^\/api\/results\/([^/]+)$/u.exec(pathname);
  if (result?.[1]) return { kind: "result", id: decode(result[1]) };
  return undefined;
}

function sendSource(response: ServerResponse, bytes: Uint8Array, mimeType: string): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": bytes.byteLength,
    "content-type": mimeType
  });
  response.end(Buffer.from(bytes));
}

export async function routeResults(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  service: ResultService | undefined
): Promise<boolean> {
  if (pathname !== "/api/results" && !pathname.startsWith("/api/results/")) return false;
  if (!service) {
    sendJson(response, 503, { error: { code: "results_unavailable", message: "Result services are not initialized." } });
    return true;
  }
  const route = shape(pathname);
  if (!route) {
    sendJson(response, 404, { error: { code: "not_found", message: "Route not found." } });
    return true;
  }
  const method = request.method ?? "GET";
  if (method !== "GET") {
    response.setHeader("allow", "GET");
    sendJson(response, 405, { error: { code: "method_not_allowed", message: "Allowed methods: GET." } });
    return true;
  }

  try {
    if (route.kind === "current") {
      const result = await service.current();
      if (!result) {
        sendJson(response, 404, { error: { code: "result_not_found", message: "No inspection result has been recorded yet." } });
        return true;
      }
      sendJson(response, 200, { result });
      return true;
    }
    if (route.kind === "source") {
      const source = await service.source(route.id);
      sendSource(response, source.bytes, source.mimeType);
      return true;
    }
    sendJson(response, 200, { result: await service.get(route.id) });
    return true;
  } catch (error) {
    if (error instanceof HttpRequestError) {
      sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
      return true;
    }
    if (error instanceof ResultDomainError) {
      const status = error.code === "not_found" ? 404 : 410;
      sendJson(response, status, { error: { code: `result_${error.code}`, message: error.message } });
      return true;
    }
    throw error;
  }
}
