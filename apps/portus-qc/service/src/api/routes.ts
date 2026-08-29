import type { IncomingMessage, ServerResponse } from "node:http";
import type { DoctorReport } from "../doctor";
import type { InspectionService } from "../domain/inspections";
import type { ArtifactService } from "../domain/artifacts";
import type { CameraService } from "../domain/cameras";
import type { CalibrationService } from "../domain/calibration";
import type { InspectionRunService } from "../domain/inspection-runs";
import type { ResultService } from "../domain/results";
import type { MoondreamSettingsService } from "../domain/moondream-settings";
import { rejectCrossOriginMutation, sendJson } from "./http";
import { routeInspections } from "./inspections";
import { routeArtifacts } from "./artifacts";
import { routeCalibration } from "./calibration";
import { routeRuns } from "./runs";
import { routeResults } from "./results";
import { routeCameras } from "./cameras";
import { routeMoondreamSettings } from "./moondream";
import type { ScheduleService } from "../domain/schedules";
import { routeSchedules } from "./schedules";
import type { VideoSessionService } from "../domain/video";
import { routeVideo } from "./video";
import { routeWeb } from "./web";
import type { ConsoleLifecycleService } from "../domain/console-lifecycle";
import { routeConsoleLifecycle } from "./console-lifecycle";

export interface RouteContext {
  startedAt: string;
  runDoctor?: () => Promise<DoctorReport>;
  inspections?: InspectionService;
  artifacts?: ArtifactService;
  cameras?: CameraService;
  calibration?: CalibrationService;
  runs?: InspectionRunService;
  results?: ResultService;
  moondreamSettings?: MoondreamSettingsService;
  schedules?: ScheduleService;
  video?: VideoSessionService;
  consoleLifecycle?: ConsoleLifecycleService;
}

export async function routeRequest(request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<void> {
  const method = request.method ?? "GET";
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (rejectCrossOriginMutation(request, response)) return;

  if (await routeRuns(request, response, pathname, context.runs, context.results)) return;
  if (await routeResults(request, response, pathname, context.results)) return;
  if (await routeInspections(request, response, pathname, context.inspections)) return;
  if (await routeArtifacts(request, response, pathname, context.artifacts)) return;
  if (await routeCalibration(request, response, pathname, context.calibration)) return;
  if (await routeCameras(request, response, pathname, context.cameras)) return;
  if (await routeMoondreamSettings(request, response, pathname, context.moondreamSettings)) return;
  if (await routeSchedules(request, response, pathname, context.schedules)) return;
  if (await routeVideo(request, response, pathname, context.video)) return;
  if (await routeConsoleLifecycle(request, response, pathname, context.consoleLifecycle)) return;

  if (method === "GET" && pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "portus-qc", local: true, startedAt: context.startedAt });
    return;
  }

  if (method === "GET" && pathname === "/api/doctor") {
    if (!context.runDoctor) {
      sendJson(response, 503, { error: { code: "doctor_unavailable", message: "Runtime diagnostics are not initialized." } });
      return;
    }
    sendJson(response, 200, await context.runDoctor());
    return;
  }

  if (await routeWeb(request, response, pathname)) return;

  if ((pathname === "/health" || pathname === "/api/doctor") && method !== "GET") {
    response.setHeader("allow", "GET");
    sendJson(response, 405, { error: { code: "method_not_allowed", message: "Only GET is supported for this route." } });
    return;
  }

  sendJson(response, 404, { error: { code: "not_found", message: "Route not found." } });
}
