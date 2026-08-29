import {
  validateCamsnapCamera,
  type CamsnapCameraConfig,
  type CamsnapCredentials
} from "@portus-qc/camsnap";
import type { CameraDefaults } from "./schema";

export type CameraSlot = 1 | 2 | 3 | 4;

export interface Camera extends Required<Pick<CamsnapCameraConfig, "id" | "host">> {
  slot: CameraSlot;
  alias?: string;
  port?: number;
  protocol: "rtsp" | "rtsps";
  stream: "stream1" | "stream2";
  path?: string;
  transport: "tcp" | "udp";
  rtspClient: "gortsplib" | "ffmpeg";
  rtspAuth: "auto" | "basic" | "digest";
}

export interface CameraView extends Camera {
  credentialsConfigured: boolean;
}

export interface CameraDraft {
  camera: Camera;
  credentials: CamsnapCredentials;
}

export class AppCameraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppCameraConfigError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AppCameraConfigError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new AppCameraConfigError(`${name} contains unsupported field(s): ${extras.join(", ")}.`);
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new AppCameraConfigError(`${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new AppCameraConfigError(`${name} must not be empty.`);
  if (normalized.length > maxLength) throw new AppCameraConfigError(`${name} must be at most ${maxLength} characters.`);
  return normalized;
}

function optionalText(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, name, maxLength);
}

function optionalPort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) throw new AppCameraConfigError("Camera port must be an integer from 1 to 65535.");
  return value;
}

function literal<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new AppCameraConfigError(`${name} must be one of: ${allowed.join(", ")}.`);
  return value as T;
}

export function parseCameraSlot(value: unknown): CameraSlot {
  if (value !== 1 && value !== 2 && value !== 3 && value !== 4) throw new AppCameraConfigError("Camera slot must be one of: 1, 2, 3, 4.");
  return value;
}

function aliasFromRecord(value: Record<string, unknown>): string | undefined {
  if (value.alias !== undefined && value.name !== undefined) throw new AppCameraConfigError("Camera input cannot contain both alias and legacy name fields.");
  return optionalText(value.alias ?? value.name, "Camera alias", 120);
}

function cameraFromRecord(
  value: Record<string, unknown>,
  defaults: CameraDefaults,
  fallback: { id?: string; slot?: CameraSlot } = {}
): Camera {
  const id = requiredText(value.id ?? fallback.id, "Camera id", 80);
  if (!ID_PATTERN.test(id)) throw new AppCameraConfigError("Camera id may contain only letters, numbers, dot, underscore, and hyphen and must start with a letter or number.");
  const slot = parseCameraSlot(value.slot ?? fallback.slot);
  const alias = aliasFromRecord(value);
  const port = optionalPort(value.port);
  const path = optionalText(value.path, "Camera path", 1000);
  const camera: Camera = {
    id,
    slot,
    host: requiredText(value.host, "Camera host", 255),
    protocol: literal(value.protocol ?? defaults.protocol, ["rtsp", "rtsps"] as const, "Camera protocol"),
    stream: literal(value.stream ?? defaults.stream, ["stream1", "stream2"] as const, "Camera stream"),
    transport: literal(value.transport ?? defaults.transport, ["tcp", "udp"] as const, "Camera transport"),
    rtspClient: literal(value.rtspClient ?? defaults.rtspClient, ["gortsplib", "ffmpeg"] as const, "Camera RTSP client"),
    rtspAuth: literal(value.rtspAuth ?? defaults.rtspAuth, ["auto", "basic", "digest"] as const, "Camera RTSP auth"),
    ...(alias !== undefined ? { alias } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(path !== undefined ? { path } : {})
  };
  try { validateCamsnapCamera(camera); }
  catch (error) { throw new AppCameraConfigError(error instanceof Error ? error.message : "Camera configuration is invalid."); }
  return camera;
}

const CAMERA_FIELDS = ["id", "slot", "alias", "host", "port", "protocol", "stream", "path", "transport", "rtspClient", "rtspAuth"] as const;
const CAMERA_EDIT_FIELDS = ["alias", "name", "host", "port", "protocol", "stream", "path", "transport", "rtspClient", "rtspAuth"] as const;
const CAMERA_TEST_FIELDS = ["id", "slot", ...CAMERA_EDIT_FIELDS] as const;
const CONNECT_FIELDS = ["slot", "alias", "host", "port", "protocol", "stream", "path", "transport", "rtspClient", "rtspAuth"] as const;
const CREDENTIAL_FIELDS = ["username", "password"] as const;

export function parseCamera(input: unknown, defaults: CameraDefaults): Camera {
  const value = record(input, "Camera");
  exactKeys(value, CAMERA_FIELDS, "Camera");
  return cameraFromRecord(value, defaults);
}

function credentialText(value: unknown, name: string, maxLength: number, requireVisibleText: boolean): string {
  if (typeof value !== "string" || value.length === 0) throw new AppCameraConfigError(`${name} must be a non-empty string.`);
  if (value.length > maxLength) throw new AppCameraConfigError(`${name} must be at most ${maxLength} characters.`);
  if (requireVisibleText && !value.trim()) throw new AppCameraConfigError(`${name} must contain a non-whitespace character.`);
  return value;
}

function credentials(value: Record<string, unknown>, required: boolean): CamsnapCredentials | undefined {
  const hasUsername = value.username !== undefined;
  const hasPassword = value.password !== undefined;
  if (!hasUsername && !hasPassword && !required) return undefined;
  if (!hasUsername || !hasPassword) throw new AppCameraConfigError("Camera username and password must be supplied together.");
  return {
    username: credentialText(value.username, "Camera username", 500, true),
    password: credentialText(value.password, "Camera password", 2000, false)
  };
}

export function parseConnectCameraInput(input: unknown, defaults: CameraDefaults, id: string): CameraDraft {
  const value = record(input, "Camera connect input");
  exactKeys(value, [...CONNECT_FIELDS, ...CREDENTIAL_FIELDS], "Camera connect input");
  return { camera: cameraFromRecord(value, defaults, { id }), credentials: credentials(value, true)! };
}

export function parseReplaceCameraInput(id: string, slot: CameraSlot, input: unknown, defaults: CameraDefaults): { camera: Camera; credentials?: CamsnapCredentials } {
  const value = record(input, "Camera replace input");
  exactKeys(value, [...CAMERA_EDIT_FIELDS, ...CREDENTIAL_FIELDS], "Camera replace input");
  const replacementCredentials = credentials(value, false);
  return {
    camera: cameraFromRecord({ ...value, id, slot }, defaults),
    ...(replacementCredentials ? { credentials: replacementCredentials } : {})
  };
}

export function parseCameraTestDraft(input: unknown, defaults: CameraDefaults): CameraDraft {
  const value = record(input, "Camera test input");
  exactKeys(value, [...CAMERA_TEST_FIELDS, ...CREDENTIAL_FIELDS], "Camera test input");
  return {
    camera: cameraFromRecord(value, defaults, { id: "draft-camera", slot: 1 }),
    credentials: credentials(value, true)!
  };
}
