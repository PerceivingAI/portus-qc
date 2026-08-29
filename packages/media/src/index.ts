import type { InferenceImage, RecordedVideoFrame, SourceMetadata } from "@portus-qc/contracts";

export interface MediaPreflightPolicy {
  maxBytes?: number;
  allowedImageTypes: readonly InferenceImage["mimeType"][];
}

export interface ImageIntake {
  id: string;
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  orientationNormalized: boolean;
  source: SourceMetadata;
}

export const defaultMediaPreflightPolicy: MediaPreflightPolicy = Object.freeze({
  allowedImageTypes: ["image/jpeg", "image/png", "image/webp"] as const
});

export class MediaPreflightError extends Error {
  constructor(readonly code: "empty_media" | "unsupported_type" | "invalid_dimensions" | "orientation_not_normalized" | "media_too_large", message: string) {
    super(message);
    this.name = "MediaPreflightError";
  }
}

export function preflightImage(input: ImageIntake, policy: MediaPreflightPolicy = defaultMediaPreflightPolicy): void {
  if (input.bytes.byteLength === 0) throw new MediaPreflightError("empty_media", "Image bytes are empty.");
  if (!policy.allowedImageTypes.includes(input.mimeType as InferenceImage["mimeType"])) throw new MediaPreflightError("unsupported_type", `Unsupported image type: ${input.mimeType}`);
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) throw new MediaPreflightError("invalid_dimensions", "Image dimensions must be positive integers.");
  if (!input.orientationNormalized) throw new MediaPreflightError("orientation_not_normalized", "Image orientation must be normalized before inference.");
  if (policy.maxBytes !== undefined && input.bytes.byteLength > policy.maxBytes) throw new MediaPreflightError("media_too_large", `Image exceeds the configured ${policy.maxBytes} byte preflight limit.`);
}

export function prepareInferenceImage(input: ImageIntake, policy: MediaPreflightPolicy = defaultMediaPreflightPolicy): InferenceImage {
  preflightImage(input, policy);
  return {
    id: input.id,
    bytes: input.bytes,
    mimeType: input.mimeType as InferenceImage["mimeType"],
    width: input.width,
    height: input.height,
    source: input.source,
    coordinateSpace: {
      sourceWidth: input.width,
      sourceHeight: input.height,
      inferenceWidth: input.width,
      inferenceHeight: input.height,
      orientationNormalized: true,
      transform: "identity"
    }
  };
}

export function makeRecordedVideoFrame(input: { id: string; timestampMs: number; image: InferenceImage }): RecordedVideoFrame {
  if (!Number.isFinite(input.timestampMs) || input.timestampMs < 0) throw new Error("Video frame timestamp must be a non-negative finite number.");
  return { id: input.id, timestampMs: input.timestampMs, image: { ...input.image, frameTimestampMs: input.timestampMs } };
}
