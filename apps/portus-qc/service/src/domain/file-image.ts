import sharp from "sharp";
import { prepareInferenceImage } from "@portus-qc/engine";
import type { InferenceImage } from "@portus-qc/contracts";

const MOONDREAM_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_NORMALIZATION_ATTEMPTS = 8;

export type FileImageMimeType = "image/jpeg" | "image/png";

export class FileImageError extends Error {
  constructor(readonly code: "invalid" | "unsupported_type" | "too_large", message: string) {
    super(message);
    this.name = "FileImageError";
  }
}

function detectedMimeType(format: string | undefined): FileImageMimeType | undefined {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  return undefined;
}

function sourceId(filename: string, id: string): string {
  const normalized = filename.trim().replace(/[\r\n\t]/gu, " ");
  const label = normalized || "selected-image";
  return `file:${id}:${label}`.slice(0, 200);
}

export async function normalizeFileImage(input: {
  id: string;
  bytes: Uint8Array;
  declaredMimeType: FileImageMimeType;
  filename: string;
  receivedAt: string;
}): Promise<InferenceImage> {
  if (input.bytes.byteLength === 0) throw new FileImageError("invalid", "Selected file is empty.");

  let detected: FileImageMimeType | undefined;
  try {
    detected = detectedMimeType((await sharp(input.bytes, { failOn: "error" }).metadata()).format);
  } catch {
    throw new FileImageError("invalid", "Selected file is not a readable image.");
  }
  if (!detected) throw new FileImageError("unsupported_type", "Only JPEG and PNG files are supported.");
  if (detected !== input.declaredMimeType) throw new FileImageError("unsupported_type", "Selected file type does not match its image content.");

  let targetWidth: number | undefined;
  for (let attempt = 0; attempt < MAX_NORMALIZATION_ATTEMPTS; attempt += 1) {
    try {
      let pipeline = sharp(input.bytes, { failOn: "error" }).rotate();
      if (targetWidth !== undefined) pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: true });
      const encoded = detected === "image/png"
        ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
        : pipeline.jpeg({ quality: 92, mozjpeg: true });
      const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
      if (!info.width || !info.height) throw new FileImageError("invalid", "Selected image dimensions are unavailable.");
      if (data.byteLength <= MOONDREAM_MAX_IMAGE_BYTES) {
        const image = prepareInferenceImage({
          id: sourceId(input.filename, input.id),
          bytes: new Uint8Array(data),
          mimeType: detected,
          width: info.width,
          height: info.height,
          orientationNormalized: true,
          source: {
            sourceId: sourceId(input.filename, input.id),
            receivedAt: input.receivedAt,
            metadata: {
              filename: input.filename.slice(0, 512),
              originalMimeType: input.declaredMimeType
            }
          }
        });
        return {
          ...image,
          coordinateSpace: {
            sourceWidth: info.width,
            sourceHeight: info.height,
            inferenceWidth: info.width,
            inferenceHeight: info.height,
            orientationNormalized: true,
            transform: "transcode"
          }
        };
      }
      const scale = Math.min(0.9, Math.sqrt(MOONDREAM_MAX_IMAGE_BYTES / data.byteLength) * 0.95);
      const nextWidth = Math.max(1, Math.floor(info.width * scale));
      if (nextWidth >= info.width || nextWidth === targetWidth) break;
      targetWidth = nextWidth;
    } catch (error) {
      if (error instanceof FileImageError) throw error;
      throw new FileImageError("invalid", "Selected image could not be normalized for Moondream.");
    }
  }

  throw new FileImageError("too_large", "Selected image could not be normalized below Moondream's 10 MB image limit.");
}
