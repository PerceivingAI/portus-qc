import { randomUUID } from "node:crypto";
import { compileInspectionDefinition, executeInspectionDefinition, InspectionConfigError, type InspectionCapability } from "@portus-qc/inspection-config";
import type { InferenceImage } from "@portus-qc/contracts";
import { VisionProviderError } from "@portus-qc/vision";
import type { ArtifactService } from "./artifacts";
import { ArtifactServiceError } from "./artifacts";
import type { CameraService } from "./cameras";
import { CameraDomainError } from "./cameras";
import type { InspectionService } from "./inspections";
import { InspectionDomainError } from "./inspections";
import { enforceMediaRetention, mediaRetentionPolicy } from "../media/retention";
import type { MediaKind, MediaStore } from "../media/store";
import type { ResultRepository, StoredInspectionResult } from "../persistence/results";
import type { ApplicationRuntime } from "../runtime";
import { RuntimeNotConfiguredError } from "../runtime/moondream";
import type { MediaConfig } from "../../../config/schema";
import { FileImageError, normalizeFileImage, type FileImageMimeType } from "./file-image";

export type InspectionRunErrorCode =
  | "inspection_not_found"
  | "inspection_disabled"
  | "camera_not_found"
  | "camera_failed"
  | "capture_not_found"
  | "file_invalid"
  | "moondream_not_configured"
  | "provider_failed"
  | "media_failed"
  | "persistence_failed"
  | "result_conflict";

export class InspectionRunError extends Error {
  constructor(readonly code: InspectionRunErrorCode, message: string) {
    super(message);
    this.name = "InspectionRunError";
  }
}

export interface InspectionRunArtifactStatus {
  status: "exported" | "failed";
  code?: string;
  message?: string;
}

export interface CapturedInspectionRun {
  id: string;
  image: InferenceImage;
}

export interface OnDemandInspectionRun {
  status: "completed";
  result: StoredInspectionResult;
  artifact: InspectionRunArtifactStatus;
  warnings: readonly { code: string; message: string }[];
}

export interface InspectionRunService {
  captureOnDemand(input: { cameraId: string; inspectionId: string }): Promise<CapturedInspectionRun>;
  captureFile(input: { inspectionId: string; filename: string; mimeType: FileImageMimeType; bytes: Uint8Array }): Promise<CapturedInspectionRun>;
  processCaptured(captureId: string): Promise<OnDemandInspectionRun>;
  runOnDemand(input: { cameraId: string; inspectionId: string }): Promise<OnDemandInspectionRun>;
  runScheduled(input: { cameraId: string; inspectionId: string }): Promise<OnDemandInspectionRun>;
  runScheduledTask(input: { cameraId: string; scheduleId: string; prompt: string; capability: InspectionCapability }): Promise<OnDemandInspectionRun>;
  runVideoFrame(input: { cameraId: string; inspectionId: string; image: InferenceImage }): Promise<OnDemandInspectionRun>;
}

type PreparedInspection = Awaited<ReturnType<InspectionService["prepare"]>>;

interface PendingCapture {
  id: string;
  createdAt: string;
  cameraId?: string;
  triggerMode: "on-demand" | "scheduled";
  prepared: PreparedInspection;
  image: InferenceImage;
}

interface PreparedExecution {
  id: string;
  createdAt: string;
  cameraId?: string;
  triggerMode: "on-demand" | "scheduled";
  inputMode: "image" | "video-frame";
  mediaKind: MediaKind;
  prepared: PreparedInspection;
  image: InferenceImage;
}

function requiredId(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new InspectionRunError(name === "cameraId" ? "camera_not_found" : "inspection_not_found", `${name} must not be empty.`);
  return normalized;
}

function requiredCaptureId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new InspectionRunError("capture_not_found", "captureId must not be empty.");
  return normalized;
}

function resultId(): string {
  return `result_${randomUUID()}`;
}

function inspectionError(error: unknown): never {
  if (error instanceof InspectionDomainError) {
    if (error.code === "not_found") throw new InspectionRunError("inspection_not_found", error.message);
    if (error.code === "disabled") throw new InspectionRunError("inspection_disabled", error.message);
  }
  throw error;
}

function cameraError(error: unknown): never {
  if (error instanceof CameraDomainError) {
    if (error.code === "not_found") throw new InspectionRunError("camera_not_found", error.message);
    throw new InspectionRunError("camera_failed", error.message);
  }
  throw error;
}

function providerError(error: unknown): never {
  if (error instanceof RuntimeNotConfiguredError) throw new InspectionRunError("moondream_not_configured", error.message);
  if (error instanceof VisionProviderError || error instanceof InspectionConfigError) {
    throw new InspectionRunError("provider_failed", "Moondream inspection inference failed.");
  }
  throw error;
}

export function createInspectionRunService(input: {
  cameras: CameraService;
  inspections: InspectionService;
  runtime: ApplicationRuntime;
  results: ResultRepository;
  artifacts: ArtifactService;
  media: MediaStore;
  mediaConfig: MediaConfig;
  now?: () => string;
  idFactory?: () => string;
}): InspectionRunService {
  const now = input.now ?? (() => new Date().toISOString());
  const makeId = input.idFactory ?? resultId;
  const retention = mediaRetentionPolicy(input.mediaConfig);
  const pending = new Map<string, PendingCapture>();
  const maxPendingCaptures = 8;

  async function prepare(inspectionIdInput: string): Promise<Awaited<ReturnType<InspectionService["prepare"]>>> {
    const inspectionId = requiredId(inspectionIdInput, "inspectionId");
    try { return await input.inspections.prepare(inspectionId); }
    catch (error) { return inspectionError(error); }
  }

  function prepareScheduledTask(scheduleIdInput: string, prompt: string, capability: InspectionCapability): PreparedInspection {
    const scheduleId = requiredId(scheduleIdInput, "inspectionId");
    try {
      const execution = compileInspectionDefinition({ id: scheduleId, name: "Scheduled task", prompt, capability });
      return {
        inspection: { id: execution.id, name: execution.name, prompt: execution.prompt, capability: execution.capability, enabled: true },
        execution
      };
    } catch (error) {
      if (error instanceof InspectionConfigError) throw new InspectionRunError("provider_failed", "Scheduled task configuration is invalid.");
      throw error;
    }
  }

  async function capturePrepared(cameraIdInput: string, prepared: PreparedInspection, triggerMode: "on-demand" | "scheduled"): Promise<CapturedInspectionRun> {
    const cameraId = requiredId(cameraIdInput, "cameraId");
    let image: Awaited<ReturnType<CameraService["snapshot"]>>;
    try { image = await input.cameras.snapshot(cameraId); }
    catch (error) { return cameraError(error); }

    const captured: PendingCapture = { id: makeId(), createdAt: now(), cameraId, triggerMode, prepared, image };
    pending.set(captured.id, captured);
    while (pending.size > maxPendingCaptures) {
      const oldest = pending.keys().next().value as string | undefined;
      if (!oldest) break;
      pending.delete(oldest);
    }
    return { id: captured.id, image };
  }

  async function capture(runInput: { cameraId: string; inspectionId: string }, triggerMode: "on-demand" | "scheduled"): Promise<CapturedInspectionRun> {
    const prepared = await prepare(runInput.inspectionId);
    return capturePrepared(runInput.cameraId, prepared, triggerMode);
  }

  async function captureFile(fileInput: { inspectionId: string; filename: string; mimeType: FileImageMimeType; bytes: Uint8Array }): Promise<CapturedInspectionRun> {
    const prepared = await prepare(fileInput.inspectionId);
    const id = makeId();
    const createdAt = now();
    let image: InferenceImage;
    try {
      image = await normalizeFileImage({
        id,
        bytes: fileInput.bytes,
        declaredMimeType: fileInput.mimeType,
        filename: fileInput.filename,
        receivedAt: createdAt
      });
    } catch (error) {
      if (error instanceof FileImageError) throw new InspectionRunError("file_invalid", error.message);
      throw error;
    }
    const captured: PendingCapture = { id, createdAt, triggerMode: "on-demand", prepared, image };
    pending.set(captured.id, captured);
    while (pending.size > maxPendingCaptures) {
      const oldest = pending.keys().next().value as string | undefined;
      if (!oldest) break;
      pending.delete(oldest);
    }
    return { id: captured.id, image };
  }

  async function execute(preparedRun: PreparedExecution): Promise<OnDemandInspectionRun> {
    const { id, createdAt, cameraId, triggerMode, inputMode, mediaKind, prepared, image } = preparedRun;
    let sourceMediaRef: string | undefined;
    try {
      const source = await input.media.save({
        id: `${id}-source`,
        kind: mediaKind,
        bytes: image.bytes,
        mimeType: image.mimeType,
        createdAt: image.source.capturedAt ?? createdAt
      });
      sourceMediaRef = source.relativePath;
    } catch {
      throw new InspectionRunError("media_failed", `The ${inputMode === "video-frame" ? "video frame" : "captured source image"} could not be retained locally.`);
    }

    const cleanupSource = async (): Promise<void> => {
      if (sourceMediaRef) await input.media.delete(sourceMediaRef).catch(() => undefined);
    };

    let response;
    try {
      const provider = await input.runtime.createMoondream();
      response = await executeInspectionDefinition(prepared.execution, image, provider);
    } catch (error) {
      await cleanupSource();
      return providerError(error);
    }

    const stored: StoredInspectionResult = {
      id,
      createdAt,
      ...(cameraId ? { cameraId } : {}),
      sourceId: image.id,
      inspectionId: prepared.inspection.id,
      inspectionName: prepared.inspection.name,
      prompt: prepared.inspection.prompt,
      capability: prepared.inspection.capability,
      inputMode,
      triggerMode,
      provider: response.provider,
      model: response.model,
      ...(response.requestId ? { requestId: response.requestId } : {}),
      ...(response.durationMs !== undefined ? { durationMs: response.durationMs } : {}),
      result: response.result,
      sourceMediaRef
    };

    try {
      if (!await input.results.create(stored)) {
        await cleanupSource();
        throw new InspectionRunError("result_conflict", "A generated result id already exists; the inspection result was not overwritten.");
      }
    } catch (error) {
      await cleanupSource();
      if (error instanceof InspectionRunError) throw error;
      throw new InspectionRunError("persistence_failed", "The inspection result could not be persisted locally.");
    }

    const warnings: Array<{ code: string; message: string }> = [];
    let artifact: InspectionRunArtifactStatus;
    try {
      await input.artifacts.exportResult(id);
      artifact = { status: "exported" };
    } catch (error) {
      const code = error instanceof ArtifactServiceError ? `artifact_${error.code}` : "artifact_export_failed";
      const message = "The inspection result was saved, but its user-facing artifact could not be exported.";
      artifact = { status: "failed", code, message };
      warnings.push({ code, message });
    }

    try {
      await enforceMediaRetention(input.media.root, retention, new Date(createdAt), [sourceMediaRef]);
    } catch {
      warnings.push({ code: "media_retention_failed", message: "The inspection completed, but internal media retention cleanup could not be completed." });
    }

    return {
      status: "completed",
      result: await input.results.get(id) ?? stored,
      artifact,
      warnings
    };
  }

  async function processCaptured(captureIdInput: string): Promise<OnDemandInspectionRun> {
    const captureId = requiredCaptureId(captureIdInput);
    const captured = pending.get(captureId);
    if (!captured) throw new InspectionRunError("capture_not_found", `Capture ${captureId} is not available for processing.`);
    pending.delete(captureId);
    return execute({
      ...captured,
      inputMode: "image",
      mediaKind: "capture"
    });
  }

  return {
    captureOnDemand(runInput): Promise<CapturedInspectionRun> { return capture(runInput, "on-demand"); },
    captureFile,
    processCaptured,
    async runOnDemand(runInput): Promise<OnDemandInspectionRun> {
      const captured = await capture(runInput, "on-demand");
      return processCaptured(captured.id);
    },
    async runScheduled(runInput): Promise<OnDemandInspectionRun> {
      const captured = await capture(runInput, "scheduled");
      return processCaptured(captured.id);
    },
    async runScheduledTask(runInput): Promise<OnDemandInspectionRun> {
      const prepared = prepareScheduledTask(runInput.scheduleId, runInput.prompt, runInput.capability);
      const captured = await capturePrepared(runInput.cameraId, prepared, "scheduled");
      return processCaptured(captured.id);
    },
    async runVideoFrame(runInput): Promise<OnDemandInspectionRun> {
      const cameraId = requiredId(runInput.cameraId, "cameraId");
      const prepared = await prepare(runInput.inspectionId);
      return execute({
        id: makeId(),
        createdAt: now(),
        cameraId,
        triggerMode: "on-demand",
        inputMode: "video-frame",
        mediaKind: "frame",
        prepared,
        image: runInput.image
      });
    }
  };
}
