import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConsoleLifecycleService } from "../domain/console-lifecycle";
import { sendJson } from "./http";

const CONSOLE_SESSION_PATH = /^\/api\/console\/session\/([A-Za-z0-9_-]{1,128})\/(heartbeat|release)$/u;

export async function routeConsoleLifecycle(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  lifecycle?: ConsoleLifecycleService
): Promise<boolean> {
  const match = CONSOLE_SESSION_PATH.exec(pathname);
  if (!match) return false;

  if ((request.method ?? "GET") !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { error: { code: "method_not_allowed", message: "Only POST is supported for Console lifecycle routes." } });
    return true;
  }

  if (!lifecycle) {
    sendJson(response, 503, { error: { code: "console_lifecycle_unavailable", message: "Console lifecycle tracking is not initialized." } });
    return true;
  }

  const sessionId = match[1]!;
  const action = match[2]!;
  if (action === "heartbeat") lifecycle.heartbeat(sessionId);
  else lifecycle.release(sessionId);
  sendJson(response, 200, { ok: true });
  return true;
}
