import { createServer, type Server } from "node:http";
import type { AppConfig } from "../../config/schema";
import type { DoctorReport } from "./doctor";
import type { InspectionService } from "./domain/inspections";
import type { ArtifactService } from "./domain/artifacts";
import type { CameraService } from "./domain/cameras";
import type { CalibrationService } from "./domain/calibration";
import type { InspectionRunService } from "./domain/inspection-runs";
import type { ResultService } from "./domain/results";
import type { MoondreamSettingsService } from "./domain/moondream-settings";
import type { ScheduleService } from "./domain/schedules";
import type { VideoSessionService } from "./domain/video";
import type { ConsoleLifecycleService } from "./domain/console-lifecycle";
import { routeRequest } from "./api/routes";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export class LocalServiceBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalServiceBindingError";
  }
}

export interface PortusQcService {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly startedAt: string;
  stop(): Promise<void>;
}

export interface StartPortusQcServiceOptions {
  config: AppConfig;
  startedAt?: string;
  onError?: (error: unknown) => void;
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

export function assertLoopbackHost(host: string): void {
  const normalized = host.trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new LocalServiceBindingError(`Portus QC local service may bind only to loopback; received host ${host}.`);
  }
}

export function createPortusQcHttpServer(input: {
  startedAt?: string;
  onError?: (error: unknown) => void;
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
} = {}): { server: Server; startedAt: string } {
  const startedAt = input.startedAt ?? new Date().toISOString();
  const server = createServer((request, response) => {
    void routeRequest(request, response, {
      startedAt,
      ...(input.runDoctor ? { runDoctor: input.runDoctor } : {}),
      ...(input.inspections ? { inspections: input.inspections } : {}),
      ...(input.artifacts ? { artifacts: input.artifacts } : {}),
      ...(input.cameras ? { cameras: input.cameras } : {}),
      ...(input.calibration ? { calibration: input.calibration } : {}),
      ...(input.runs ? { runs: input.runs } : {}),
      ...(input.results ? { results: input.results } : {}),
      ...(input.moondreamSettings ? { moondreamSettings: input.moondreamSettings } : {}),
      ...(input.schedules ? { schedules: input.schedules } : {}),
      ...(input.video ? { video: input.video } : {}),
      ...(input.consoleLifecycle ? { consoleLifecycle: input.consoleLifecycle } : {})
    }).catch(() => {
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      const payload = JSON.stringify({ error: { code: "internal_error", message: "Local service request failed." } });
      response.writeHead(500, {
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(payload),
        "content-type": "application/json; charset=utf-8"
      });
      response.end(payload);
    });
  });
  if (input.onError) {
    server.on("clientError", (error, socket) => {
      input.onError?.(error);
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      else socket.destroy();
    });
  }
  return { server, startedAt };
}

function displayHost(host: string): string {
  return host === "::1" ? "[::1]" : host;
}

export async function startPortusQcService(options: StartPortusQcServiceOptions): Promise<PortusQcService> {
  const host = options.config.runtime.host.trim().toLowerCase();
  assertLoopbackHost(host);
  const configuredPort = options.config.runtime.port;
  const { server, startedAt } = createPortusQcHttpServer({
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.runDoctor ? { runDoctor: options.runDoctor } : {}),
    ...(options.inspections ? { inspections: options.inspections } : {}),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.cameras ? { cameras: options.cameras } : {}),
    ...(options.calibration ? { calibration: options.calibration } : {}),
    ...(options.runs ? { runs: options.runs } : {}),
    ...(options.results ? { results: options.results } : {}),
    ...(options.moondreamSettings ? { moondreamSettings: options.moondreamSettings } : {}),
    ...(options.schedules ? { schedules: options.schedules } : {}),
    ...(options.video ? { video: options.video } : {}),
    ...(options.consoleLifecycle ? { consoleLifecycle: options.consoleLifecycle } : {})
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port: configuredPort });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Portus QC local service did not expose a TCP address after startup.");
  }

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    });
    return stopPromise;
  };

  return {
    host,
    port: address.port,
    url: `http://${displayHost(host)}:${address.port}`,
    startedAt,
    stop
  };
}
