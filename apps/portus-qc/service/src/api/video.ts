import type { IncomingMessage, ServerResponse } from "node:http";
import { VideoDomainError, type VideoSessionService } from "../domain/video";
import { HttpRequestError, readJsonBody, sendJson } from "./http";

function statusCode(error: VideoDomainError): number {
  if (error.code === "invalid") return 400;
  if (error.code === "camera_not_found" || error.code === "inspection_not_found") return 404;
  if (error.code === "conflict" || error.code === "not_running") return 409;
  if (error.code === "runtime_unavailable") return 503;
  return 502;
}

export async function routeVideo(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  video: VideoSessionService | undefined
): Promise<boolean> {
  if (pathname !== "/api/video/session") return false;
  if (!video) {
    sendJson(response, 503, { error: { code: "video_unavailable", message: "Video session service is not initialized." } });
    return true;
  }
  const method = request.method ?? "GET";
  try {
    if (method === "GET") {
      sendJson(response, 200, { session: video.status() ?? null });
      return true;
    }
    if (method === "POST") {
      sendJson(response, 201, { session: await video.start(await readJsonBody(request)) });
      return true;
    }
    if (method === "DELETE") {
      sendJson(response, 200, { session: await video.stop() });
      return true;
    }
    response.setHeader("allow", "GET, POST, DELETE");
    sendJson(response, 405, { error: { code: "method_not_allowed", message: "Allowed methods: GET, POST, DELETE." } });
    return true;
  } catch (error) {
    if (error instanceof HttpRequestError) {
      sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
      return true;
    }
    if (error instanceof VideoDomainError) {
      sendJson(response, statusCode(error), { error: { code: `video_${error.code}`, message: error.message } });
      return true;
    }
    throw error;
  }
}
