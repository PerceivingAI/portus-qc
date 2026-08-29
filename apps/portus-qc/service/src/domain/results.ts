import type { VisionCapability, VisionResult } from "@portus-qc/contracts";
import { mediaMimeTypeForPath, type MediaStore, type SupportedMediaMimeType } from "../media/store";
import type { ResultRepository, StoredInspectionResult } from "../persistence/results";

export type ResultDomainErrorCode = "not_found" | "source_unavailable";

export class ResultDomainError extends Error {
  constructor(readonly code: ResultDomainErrorCode, message: string) {
    super(message);
    this.name = "ResultDomainError";
  }
}

export interface ResultView {
  id: string;
  createdAt: string;
  cameraId?: string;
  sourceId: string;
  inspectionId: string;
  inspectionName: string;
  prompt: string;
  capability: VisionCapability;
  inputMode: "image" | "video-frame";
  triggerMode: "on-demand" | "scheduled";
  provider: string;
  model: string;
  requestId?: string;
  durationMs?: number;
  result: VisionResult;
  source: { available: boolean; url?: string };
  artifact: { exported: boolean };
}

export interface ResultSource {
  bytes: Uint8Array;
  mimeType: SupportedMediaMimeType;
}

export interface ResultService {
  current(): Promise<ResultView | undefined>;
  get(id: string): Promise<ResultView>;
  source(id: string): Promise<ResultSource>;
  view(result: StoredInspectionResult): ResultView;
}

function normalizedId(id: string): string {
  const value = id.trim();
  if (!value) throw new ResultDomainError("not_found", "Result id must not be empty.");
  return value;
}

export function createResultService(input: { results: ResultRepository; media: MediaStore }): ResultService {
  const { results, media } = input;

  function view(result: StoredInspectionResult): ResultView {
    return {
      id: result.id,
      createdAt: result.createdAt,
      ...(result.cameraId ? { cameraId: result.cameraId } : {}),
      sourceId: result.sourceId,
      inspectionId: result.inspectionId,
      inspectionName: result.inspectionName,
      prompt: result.prompt,
      capability: result.capability,
      inputMode: result.inputMode,
      triggerMode: result.triggerMode,
      provider: result.provider,
      model: result.model,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      result: result.result,
      source: result.sourceMediaRef
        ? { available: true, url: `/api/results/${encodeURIComponent(result.id)}/source` }
        : { available: false },
      artifact: { exported: result.artifactRef !== undefined }
    };
  }

  async function stored(id: string): Promise<StoredInspectionResult> {
    const result = await results.get(normalizedId(id));
    if (!result) throw new ResultDomainError("not_found", `Result ${id} was not found.`);
    return result;
  }

  return {
    view,
    async current(): Promise<ResultView | undefined> {
      const [result] = await results.listRecent(1);
      return result ? view(result) : undefined;
    },
    async get(id: string): Promise<ResultView> {
      return view(await stored(id));
    },
    async source(id: string): Promise<ResultSource> {
      const result = await stored(id);
      if (!result.sourceMediaRef) throw new ResultDomainError("source_unavailable", `Result ${result.id} has no retained source image.`);
      const mimeType = mediaMimeTypeForPath(result.sourceMediaRef);
      if (mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/webp") {
        throw new ResultDomainError("source_unavailable", `Result ${result.id} source image type is unavailable.`);
      }
      try {
        return { bytes: await media.read(result.sourceMediaRef), mimeType };
      } catch {
        throw new ResultDomainError("source_unavailable", `Result ${result.id} retained source image is unavailable.`);
      }
    }
  };
}
