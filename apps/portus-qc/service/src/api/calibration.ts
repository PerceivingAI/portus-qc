import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CalibrationDomainError, type CalibrationService } from "../domain/calibration";
import { FileImageError, normalizeFileImage, type FileImageMimeType } from "../domain/file-image";
import { HttpRequestError, readBinaryBody, sendJson } from "./http";

const MAX_CALIBRATION_UPLOAD_BYTES = 50 * 1024 * 1024;
const CALIBRATION_CONTENT_TYPES = ["image/jpeg", "image/png"] as const;

function status(error: CalibrationDomainError): number {
  if (error.code === "moondream_not_configured") return 503;
  return 500;
}

function fileImageStatus(error: FileImageError): number {
  if (error.code === "too_large") return 413;
  if (error.code === "unsupported_type") return 415;
  return 400;
}

export async function routeCalibration(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  service: CalibrationService | undefined
): Promise<boolean> {
  if (pathname !== "/api/calibration") return false;
  if (!service) {
    sendJson(response, 503, { error: { code: "calibration_unavailable", message: "Calibration services are not initialized." } });
    return true;
  }
  const method = request.method ?? "GET";
  if (method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { error: { code: "method_not_allowed", message: "Allowed methods: POST." } });
    return true;
  }
  try {
    const body = await readBinaryBody(request, {
      maxBytes: MAX_CALIBRATION_UPLOAD_BYTES,
      allowedContentTypes: CALIBRATION_CONTENT_TYPES
    });
    const image = await normalizeFileImage({
      id: `calibration_${randomUUID()}`,
      bytes: body.bytes,
      declaredMimeType: body.mimeType as FileImageMimeType,
      filename: "visible-input",
      receivedAt: new Date().toISOString()
    });
    sendJson(response, 200, { calibration: await service.calibrate(image) });
    return true;
  } catch (error) {
    if (error instanceof HttpRequestError) {
      sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
      return true;
    }
    if (error instanceof FileImageError) {
      sendJson(response, fileImageStatus(error), { error: { code: `calibration_${error.code}`, message: error.message } });
      return true;
    }
    if (error instanceof CalibrationDomainError) {
      sendJson(response, status(error), { error: { code: `calibration_${error.code}`, message: error.message } });
      return true;
    }
    throw error;
  }
}
