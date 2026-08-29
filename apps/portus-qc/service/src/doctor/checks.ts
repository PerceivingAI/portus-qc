import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CameraService } from "../domain/cameras";
import type { LocalApplicationState } from "../local-state";
import type { ApplicationRuntime } from "../runtime";
import { doctorStatus, type DoctorCheck, type DoctorReport } from "./report";

const MIN_NODE_VERSION = [22, 13, 0] as const;

function parseNodeVersion(version: string): readonly number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function nodeSupported(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  const [major = 0, minor = 0, patch = 0] = parsed;
  const [requiredMajor, requiredMinor, requiredPatch] = MIN_NODE_VERSION;
  if (major !== requiredMajor) return major > requiredMajor;
  if (minor !== requiredMinor) return minor > requiredMinor;
  return patch >= requiredPatch;
}

function nodeCheck(version = process.version): DoctorCheck {
  const supported = nodeSupported(version);
  return {
    id: "node",
    label: "Node.js",
    status: supported ? "ok" : "error",
    message: supported ? `Node ${version} satisfies the local app runtime requirement.` : `Node ${version} is unsupported; Portus QC requires Node 22.13.0 or newer.`,
    details: { version, minimum: "22.13.0" }
  };
}

async function dataDirectoryCheck(state: LocalApplicationState): Promise<DoctorCheck> {
  const probe = join(state.paths.dataRoot, `.doctor-${randomUUID()}.tmp`);
  try {
    await mkdir(state.paths.dataRoot, { recursive: true, mode: 0o700 });
    await writeFile(probe, "portus-qc-doctor", { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rm(probe, { force: true });
    return {
      id: "data_directory",
      label: "Local data",
      status: "ok",
      message: "Local application data directory is writable.",
      details: { path: state.paths.dataRoot }
    };
  } catch {
    await rm(probe, { force: true }).catch(() => undefined);
    return {
      id: "data_directory",
      label: "Local data",
      status: "error",
      message: "Local application data directory is not writable.",
      details: { path: state.paths.dataRoot }
    };
  }
}

async function moondreamCheck(runtime: ApplicationRuntime): Promise<DoctorCheck> {
  const configured = await runtime.moondreamConfigured();
  return {
    id: "moondream",
    label: "Moondream",
    status: configured ? "ok" : "attention",
    message: configured ? "Moondream API key is configured." : "Moondream API key is not configured yet.",
    details: { configured }
  };
}

async function executableCheck(
  id: "camsnap" | "ffmpeg",
  label: string,
  probe: () => ReturnType<ApplicationRuntime["probeCamsnap"]>
): Promise<DoctorCheck> {
  const result = await probe();
  if (!result.available) {
    return {
      id,
      label,
      status: "attention",
      message: `${label} is not available (${result.error ?? "unknown"}).`,
      details: { executable: result.executable, available: false }
    };
  }
  return {
    id,
    label,
    status: "ok",
    message: `${label} is available.`,
    details: {
      executable: result.executable,
      available: true,
      ...(result.resolvedPath ? { resolvedPath: result.resolvedPath } : {}),
      ...(result.version ? { version: result.version } : {})
    }
  };
}

async function cameraChecks(service: Pick<CameraService, "list" | "test">, camsnapAvailable: boolean): Promise<readonly DoctorCheck[]> {
  const cameras = await service.list();
  const checks: DoctorCheck[] = [];
  for (const camera of cameras) {
    if (!camsnapAvailable) {
      checks.push({
        id: "camera",
        label: camera.alias ? `Camera ${camera.slot}: ${camera.alias}` : `Camera ${camera.slot}`,
        status: "attention",
        message: "Camera was not probed because Camsnap is unavailable.",
        details: { cameraId: camera.id, reachable: false, reason: "camsnap_unavailable" }
      });
      continue;
    }
    try {
      const probe = await service.test(camera.id);
      checks.push({
        id: "camera",
        label: camera.alias ? `Camera ${camera.slot}: ${camera.alias}` : `Camera ${camera.slot}`,
        status: probe.reachable ? "ok" : "attention",
        message: probe.reachable ? "Camera is reachable." : `Camera reachability check failed (${probe.reason ?? "unknown"}).`,
        details: {
          cameraId: camera.id,
          reachable: probe.reachable,
          ...(probe.reason ? { reason: probe.reason } : {})
        }
      });
    } catch (error) {
      checks.push({
        id: "camera",
        label: camera.alias ? `Camera ${camera.slot}: ${camera.alias}` : `Camera ${camera.slot}`,
        status: "attention",
        message: "Camera reachability check could not be completed.",
        details: { cameraId: camera.id, reachable: false }
      });
    }
  }
  return checks;
}

export interface RunDoctorOptions {
  nodeVersion?: string;
  now?: () => string;
  cameras?: Pick<CameraService, "list" | "test">;
}

export async function runDoctor(
  state: LocalApplicationState,
  runtime: ApplicationRuntime,
  options: RunDoctorOptions = {}
): Promise<DoctorReport> {
  const [dataDirectory, moondream, camsnap, ffmpeg] = await Promise.all([
    dataDirectoryCheck(state),
    moondreamCheck(runtime),
    executableCheck("camsnap", "Camsnap", () => runtime.probeCamsnap()),
    executableCheck("ffmpeg", "FFmpeg", () => runtime.probeFfmpeg())
  ]);
  const cameras = options.cameras ? await cameraChecks(options.cameras, camsnap.status === "ok") : [];
  const checks: DoctorCheck[] = [nodeCheck(options.nodeVersion), dataDirectory, moondream, camsnap, ffmpeg, ...cameras];
  return {
    status: doctorStatus(checks),
    checkedAt: (options.now ?? (() => new Date().toISOString()))(),
    checks
  };
}
