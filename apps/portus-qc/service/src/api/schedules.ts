import type { IncomingMessage, ServerResponse } from "node:http";
import { ScheduleDomainError, type ScheduleService } from "../domain/schedules";
import { readJsonBody, sendJson } from "./http";

function scheduleId(pathname: string): string | undefined {
  const match = /^\/api\/schedules\/([^/]+)$/u.exec(pathname);
  if (!match?.[1]) return undefined;
  try { return decodeURIComponent(match[1]); }
  catch { return undefined; }
}

function status(error: ScheduleDomainError): number {
  if (error.code === "not_found" || error.code === "camera_not_found") return 404;
  if (error.code === "limit" || error.code === "conflict") return 409;
  if (error.code === "invalid") return 400;
  return 500;
}

function enabledBody(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScheduleDomainError("invalid", "Schedule state body must be an object.");
  const record = value as Record<string, unknown>;
  const extras = Object.keys(record).filter((key) => key !== "enabled");
  if (extras.length || typeof record.enabled !== "boolean") throw new ScheduleDomainError("invalid", "Schedule state body must contain only boolean enabled.");
  return record.enabled;
}

export async function routeSchedules(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  schedules: ScheduleService | undefined
): Promise<boolean> {
  const id = scheduleId(pathname);
  if (pathname !== "/api/schedules" && id === undefined) return false;
  if (!schedules) {
    sendJson(response, 503, { error: { code: "schedules_unavailable", message: "Scheduling services are not initialized." } });
    return true;
  }
  const method = request.method ?? "GET";
  try {
    if (pathname === "/api/schedules") {
      if (method === "GET") {
        const policy = schedules.policy();
        sendJson(response, 200, {
          schedules: await schedules.list(),
          policy: {
            minIntervalMs: policy.minIntervalMs,
            maxIntervalMs: policy.maxIntervalMs,
            overlapPolicy: policy.overlapPolicy,
            maxSchedules: policy.maxSchedules
          }
        });
        return true;
      }
      if (method === "POST") {
        sendJson(response, 201, { schedule: await schedules.create(await readJsonBody(request)) });
        return true;
      }
      response.setHeader("allow", "GET, POST");
      sendJson(response, 405, { error: { code: "method_not_allowed", message: "Allowed methods: GET, POST." } });
      return true;
    }

    if (method === "PUT") {
      sendJson(response, 200, { schedule: await schedules.replace(id!, await readJsonBody(request)) });
      return true;
    }
    if (method === "PATCH") {
      sendJson(response, 200, { schedule: await schedules.setEnabled(id!, enabledBody(await readJsonBody(request))) });
      return true;
    }
    if (method === "DELETE") {
      await schedules.delete(id!);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return true;
    }
    response.setHeader("allow", "PUT, PATCH, DELETE");
    sendJson(response, 405, { error: { code: "method_not_allowed", message: "Allowed methods: PUT, PATCH, DELETE." } });
    return true;
  } catch (error) {
    if (error instanceof ScheduleDomainError) {
      sendJson(response, status(error), { error: { code: `schedule_${error.code}`, message: error.message } });
      return true;
    }
    throw error;
  }
}
