import { randomUUID } from "node:crypto";
import type { VideoConfig } from "../../../config/schema";
import type { CameraService } from "./cameras";
import { CameraDomainError } from "./cameras";
import type { InspectionService } from "./inspections";
import { InspectionDomainError } from "./inspections";
import type { InspectionRunService } from "./inspection-runs";
import type { ApplicationRuntime } from "../runtime";
import { RuntimeExecutableNotFoundError } from "../runtime/executable";
import type { VideoFrameExtractor } from "../runtime/video";

export type VideoSessionStatus = "running" | "stopping" | "completed" | "failed";
export type VideoDomainErrorCode = "invalid" | "conflict" | "not_running" | "camera_not_found" | "inspection_not_found" | "runtime_unavailable" | "operation_failed";

export class VideoDomainError extends Error {
  constructor(readonly code: VideoDomainErrorCode, message: string) {
    super(message);
    this.name = "VideoDomainError";
  }
}

export interface VideoSessionView {
  id: string;
  cameraId: string;
  inspectionId: string;
  status: VideoSessionStatus;
  startedAt: string;
  finishedAt?: string;
  framesPerSecond: number;
  maxOutstandingInferences: number;
  clipsCaptured: number;
  framesExtracted: number;
  framesAnalyzed: number;
  framesDropped: number;
  framesFailed: number;
  latestResultId?: string;
  lastError?: string;
}

export interface VideoSessionService {
  status(): VideoSessionView | undefined;
  start(input: unknown): Promise<VideoSessionView>;
  stop(): Promise<VideoSessionView>;
  shutdown(): Promise<void>;
}

interface ActiveVideoSession extends VideoSessionView {
  startedMs: number;
  frameIntervalMs: number;
  stopRequested: boolean;
  fatalError?: unknown;
  inFlight: Set<Promise<void>>;
  done?: Promise<void>;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new VideoDomainError("invalid", `${name} must be a non-empty string.`);
  return value.trim();
}

function parseStartInput(value: unknown): { cameraId: string; inspectionId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VideoDomainError("invalid", "Video session body must be an object.");
  const record = value as Record<string, unknown>;
  const extras = Object.keys(record).filter((key) => key !== "cameraId" && key !== "inspectionId");
  if (extras.length) throw new VideoDomainError("invalid", `Video session body contains unsupported field(s): ${extras.join(", ")}.`);
  return {
    cameraId: requiredText(record.cameraId, "cameraId"),
    inspectionId: requiredText(record.inspectionId, "inspectionId")
  };
}

function sessionId(): string { return `video_${randomUUID()}`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Video session failed."; }

export function createVideoSessionService(input: {
  cameras: CameraService;
  inspections: InspectionService;
  runs: InspectionRunService;
  runtime: ApplicationRuntime;
  extractor: VideoFrameExtractor;
  config: VideoConfig;
  nowMs?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  idFactory?: () => string;
  onError?: (error: unknown) => void;
}): VideoSessionService {
  const frameIntervalMs = Math.max(1, Math.ceil(1000 / input.config.framesPerSecond));
  const nowMs = input.nowMs ?? (() => Date.now());
  const sleep = input.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const makeId = input.idFactory ?? sessionId;
  let active: ActiveVideoSession | undefined;
  let latest: VideoSessionView | undefined;

  function view(session: ActiveVideoSession): VideoSessionView {
    return {
      id: session.id,
      cameraId: session.cameraId,
      inspectionId: session.inspectionId,
      status: session.status,
      startedAt: session.startedAt,
      ...(session.finishedAt ? { finishedAt: session.finishedAt } : {}),
      framesPerSecond: session.framesPerSecond,
      maxOutstandingInferences: session.maxOutstandingInferences,
      clipsCaptured: session.clipsCaptured,
      framesExtracted: session.framesExtracted,
      framesAnalyzed: session.framesAnalyzed,
      framesDropped: session.framesDropped,
      framesFailed: session.framesFailed,
      ...(session.latestResultId ? { latestResultId: session.latestResultId } : {}),
      ...(session.lastError ? { lastError: session.lastError } : {})
    };
  }

  async function validateStart(cameraId: string, inspectionId: string): Promise<void> {
    try { await input.cameras.get(cameraId); }
    catch (error) {
      if (error instanceof CameraDomainError && error.code === "not_found") throw new VideoDomainError("camera_not_found", error.message);
      throw error;
    }
    try { await input.inspections.prepare(inspectionId); }
    catch (error) {
      if (error instanceof InspectionDomainError && (error.code === "not_found" || error.code === "disabled")) {
        throw new VideoDomainError("inspection_not_found", error.message);
      }
      throw error;
    }
    try { await input.runtime.resolveFfmpeg(); }
    catch (error) {
      if (error instanceof RuntimeExecutableNotFoundError) throw new VideoDomainError("runtime_unavailable", "FFmpeg is required for video frame extraction. Run Doctor for executable diagnostics.");
      throw error;
    }
    if (!await input.runtime.moondreamConfigured()) throw new VideoDomainError("runtime_unavailable", "Moondream must be configured before starting video analysis.");
  }

  function beginInference(session: ActiveVideoSession, image: Awaited<ReturnType<VideoFrameExtractor["extract"]>>): void {
    let job: Promise<void>;
    job = (async () => {
      try {
        const result = await input.runs.runVideoFrame({ cameraId: session.cameraId, inspectionId: session.inspectionId, image });
        session.framesAnalyzed += 1;
        session.latestResultId = result.result.id;
      } catch (error) {
        session.framesFailed += 1;
        session.lastError = errorMessage(error);
        session.fatalError = error;
        session.stopRequested = true;
        input.onError?.(error);
      }
    })().finally(() => { session.inFlight.delete(job); });
    session.inFlight.add(job);
  }

  async function run(session: ActiveVideoSession): Promise<void> {
    let nextCycleAt = session.startedMs;
    let frameIndex = 0;
    try {
      while (!session.stopRequested) {
        const current = nowMs();
        if (current < nextCycleAt) {
          await sleep(nextCycleAt - current);
          if (session.stopRequested) break;
        }

        const cycleStarted = nowMs();
        nextCycleAt = cycleStarted + session.frameIntervalMs;
        if (session.inFlight.size >= session.maxOutstandingInferences) {
          session.framesDropped += 1;
          continue;
        }

        const clip = await input.cameras.clip(session.cameraId, session.frameIntervalMs);
        session.clipsCaptured += 1;
        if (session.stopRequested) break;

        const frame = await input.extractor.extract({
          clip,
          cameraId: session.cameraId,
          sessionId: session.id,
          frameId: `${session.id}-frame-${++frameIndex}`,
          frameTimestampMs: Math.max(0, cycleStarted - session.startedMs)
        });
        session.framesExtracted += 1;
        beginInference(session, frame);
      }
    } catch (error) {
      session.fatalError = error;
      session.lastError = errorMessage(error);
      session.stopRequested = true;
      input.onError?.(error);
    }

    await Promise.allSettled([...session.inFlight]);
    session.status = session.fatalError ? "failed" : "completed";
    session.finishedAt = new Date(nowMs()).toISOString();
    latest = view(session);
    if (active?.id === session.id) active = undefined;
  }

  return {
    status(): VideoSessionView | undefined { return active ? view(active) : latest; },

    async start(value: unknown): Promise<VideoSessionView> {
      if (active && (active.status === "running" || active.status === "stopping")) {
        throw new VideoDomainError("conflict", "A video session is already active. Stop it before starting another one.");
      }
      const parsed = parseStartInput(value);
      await validateStart(parsed.cameraId, parsed.inspectionId);
      const startedMs = nowMs();
      const session: ActiveVideoSession = {
        id: makeId(),
        cameraId: parsed.cameraId,
        inspectionId: parsed.inspectionId,
        status: "running",
        startedAt: new Date(startedMs).toISOString(),
        framesPerSecond: input.config.framesPerSecond,
        maxOutstandingInferences: input.config.maxOutstandingInferences,
        clipsCaptured: 0,
        framesExtracted: 0,
        framesAnalyzed: 0,
        framesDropped: 0,
        framesFailed: 0,
        startedMs,
        frameIntervalMs,
        stopRequested: false,
        inFlight: new Set()
      };
      active = session;
      latest = undefined;
      session.done = run(session);
      return view(session);
    },

    async stop(): Promise<VideoSessionView> {
      const session = active;
      if (!session || (session.status !== "running" && session.status !== "stopping")) {
        throw new VideoDomainError("not_running", "No video session is currently running.");
      }
      session.stopRequested = true;
      session.status = "stopping";
      await session.done;
      return latest ?? view(session);
    },

    async shutdown(): Promise<void> {
      const session = active;
      if (!session) return;
      session.stopRequested = true;
      session.status = "stopping";
      await session.done;
    }
  };
}
