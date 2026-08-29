import { randomUUID } from "node:crypto";
import {
  CamsnapCameraAdapter,
  CamsnapOperationalError,
  type CamsnapCameraDescriptor,
  type CamsnapClip,
  type CamsnapOperationalErrorCode
} from "@portus-qc/camsnap";
import type { InferenceImage } from "@portus-qc/contracts";
import {
  AppCameraConfigError,
  parseCameraSlot,
  parseCameraTestDraft,
  parseConnectCameraInput,
  parseReplaceCameraInput,
  type Camera,
  type CameraSlot,
  type CameraView
} from "../../../config/camera";
import type { AppConfig, AppConfigOverrides, CameraDefaults } from "../../../config/schema";
import type { CameraRepository } from "../persistence/cameras";
import type { AppSettingsRepository } from "../persistence/settings";
import type { ApplicationRuntime } from "../runtime";
import { RuntimeExecutableNotFoundError } from "../runtime/executable";
import { secretKeys, type SecretStore } from "../secrets/store";

export type CameraDomainErrorCode = "invalid" | "not_found" | "conflict" | "runtime_unavailable" | "operation_failed";

export class CameraDomainError extends Error {
  constructor(
    readonly code: CameraDomainErrorCode,
    message: string,
    readonly reason?: CamsnapOperationalErrorCode
  ) {
    super(message);
    this.name = "CameraDomainError";
  }
}

export interface CameraProbeResult {
  cameraId: string;
  reachable: boolean;
  checkedAt: string;
  reason?: CamsnapOperationalErrorCode;
}

export interface CameraCredentialsView {
  username: string;
  password: string;
}

export interface CameraService {
  list(): Promise<readonly CameraView[]>;
  get(id: string): Promise<CameraView>;
  credentials(id: string): Promise<CameraCredentialsView>;
  connect(input: unknown): Promise<CameraView>;
  replace(id: string, input: unknown): Promise<CameraView>;
  move(id: string, slot: unknown): Promise<CameraView>;
  delete(id: string): Promise<void>;
  test(id: string): Promise<CameraProbeResult>;
  testDraft(input: unknown): Promise<CameraProbeResult>;
  discover(): Promise<readonly CamsnapCameraDescriptor[]>;
  snapshot(id: string): Promise<InferenceImage>;
  clip(id: string, durationMs: number): Promise<CamsnapClip>;
  selectedId(): Promise<string | undefined>;
  select(id: string | undefined): Promise<void>;
}

function normalizedId(id: string): string {
  const value = id.trim();
  if (!value) throw new CameraDomainError("invalid", "Camera id must not be empty.");
  return value;
}

function invalid(error: unknown): never {
  if (error instanceof CameraDomainError) throw error;
  if (error instanceof AppCameraConfigError) throw new CameraDomainError("invalid", error.message);
  throw error;
}

async function credentialState(secrets: SecretStore, cameraId: string): Promise<{ username?: string; password?: string }> {
  const [username, password] = await Promise.all([
    secrets.get(secretKeys.cameraUsername(cameraId)),
    secrets.get(secretKeys.cameraPassword(cameraId))
  ]);
  return {
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {})
  };
}

async function restoreSecret(secrets: SecretStore, key: string, value: string | undefined): Promise<void> {
  if (value === undefined) await secrets.delete(key);
  else await secrets.set(key, value);
}

function runtimeError(error: unknown, operation: string): never {
  if (error instanceof CameraDomainError) throw error;
  if (error instanceof RuntimeExecutableNotFoundError) {
    throw new CameraDomainError("runtime_unavailable", "Camsnap is not available. Run Doctor for executable diagnostics.");
  }
  if (error instanceof CamsnapOperationalError) {
    throw new CameraDomainError("operation_failed", `${operation} failed (${error.code}).`, error.code);
  }
  throw error;
}

export function createCameraService(input: {
  repository: CameraRepository;
  secrets: SecretStore;
  runtime: ApplicationRuntime;
  defaults: CameraDefaults;
  config: AppConfig;
  settingsRepository: AppSettingsRepository;
  idFactory?: () => string;
}): CameraService {
  const { repository, secrets, runtime, defaults, config, settingsRepository } = input;
  const idFactory = input.idFactory ?? (() => `camera-${randomUUID()}`);

  async function view(camera: Camera): Promise<CameraView> {
    const [username, password] = await Promise.all([
      secrets.has(secretKeys.cameraUsername(camera.id)),
      secrets.has(secretKeys.cameraPassword(camera.id))
    ]);
    return { ...camera, credentialsConfigured: username && password };
  }

  async function camera(id: string): Promise<Camera> {
    const found = await repository.get(normalizedId(id));
    if (!found) throw new CameraDomainError("not_found", `Camera ${id} was not found.`);
    return found;
  }

  function settingsWithSelectedCamera(existing: AppConfigOverrides | undefined, cameraId: string | undefined): AppConfigOverrides {
    const next = structuredClone(existing ?? {});
    const consoleSettings = { ...(next.console ?? {}) };
    if (cameraId === undefined) delete consoleSettings.selectedCameraId;
    else consoleSettings.selectedCameraId = cameraId;
    if (Object.keys(consoleSettings).length === 0) delete next.console;
    else next.console = consoleSettings;
    return next;
  }

  async function persistSelection(cameraId: string | undefined): Promise<void> {
    await settingsRepository.update((current) => {
      const next = settingsWithSelectedCamera(current, cameraId);
      return Object.keys(next).length === 0 ? undefined : next;
    });
    config.console.selectedCameraId = cameraId ?? null;
  }

  async function productionHealth(target: Camera, credentials?: { username: string; password: string }): Promise<CameraProbeResult> {
    try {
      const image = await runtime.withCamsnap(async (camsnapRuntime) => {
        const adapter = new CamsnapCameraAdapter({ cameras: [target], runtime: camsnapRuntime });
        return adapter.snapshot(target.id);
      }, credentials);
      return { cameraId: target.id, reachable: true, checkedAt: image.source.receivedAt };
    } catch (error) {
      if (error instanceof RuntimeExecutableNotFoundError) {
        throw new CameraDomainError("runtime_unavailable", "Camsnap is not available. Run Doctor for executable diagnostics.");
      }
      if (error instanceof CamsnapOperationalError) {
        return { cameraId: target.id, reachable: false, checkedAt: new Date().toISOString(), reason: error.code };
      }
      throw error;
    }
  }

  async function persist(target: Camera, credentials: { username: string; password: string }): Promise<CameraView> {
    if (!await repository.create(target)) throw new CameraDomainError("conflict", `Camera slot ${target.slot} is already configured.`);
    try {
      await secrets.set(secretKeys.cameraUsername(target.id), credentials.username);
      await secrets.set(secretKeys.cameraPassword(target.id), credentials.password);
    } catch (error) {
      await Promise.allSettled([
        secrets.delete(secretKeys.cameraUsername(target.id)),
        secrets.delete(secretKeys.cameraPassword(target.id))
      ]);
      await repository.delete(target.id);
      throw error;
    }
    return view(target);
  }

  return {
    async list(): Promise<readonly CameraView[]> {
      return Promise.all((await repository.list()).map((item) => view(item)));
    },

    async get(id: string): Promise<CameraView> {
      return view(await camera(id));
    },

    async credentials(id: string): Promise<CameraCredentialsView> {
      const existing = await camera(id);
      const saved = await credentialState(secrets, existing.id);
      return { username: saved.username ?? "", password: saved.password ?? "" };
    },

    async connect(value: unknown): Promise<CameraView> {
      let parsed: ReturnType<typeof parseConnectCameraInput>;
      try { parsed = parseConnectCameraInput(value, defaults, idFactory()); }
      catch (error) { return invalid(error); }
      if (await repository.getBySlot(parsed.camera.slot)) throw new CameraDomainError("conflict", `Camera slot ${parsed.camera.slot} is already configured.`);
      const validation = await productionHealth(parsed.camera, parsed.credentials);
      if (!validation.reachable) throw new CameraDomainError("operation_failed", "Camera connection failed.", validation.reason);
      return persist(parsed.camera, parsed.credentials);
    },

    async replace(id: string, value: unknown): Promise<CameraView> {
      const existing = await camera(id);
      let parsed: ReturnType<typeof parseReplaceCameraInput>;
      try { parsed = parseReplaceCameraInput(existing.id, existing.slot, value, defaults); }
      catch (error) { return invalid(error); }
      const previousSecrets = parsed.credentials ? await credentialState(secrets, existing.id) : undefined;
      if (!await repository.replace(parsed.camera)) throw new CameraDomainError("not_found", `Camera ${existing.id} was not found.`);
      if (parsed.credentials) {
        try {
          await secrets.set(secretKeys.cameraUsername(existing.id), parsed.credentials.username);
          await secrets.set(secretKeys.cameraPassword(existing.id), parsed.credentials.password);
        } catch (error) {
          await repository.replace(existing);
          await Promise.allSettled([
            restoreSecret(secrets, secretKeys.cameraUsername(existing.id), previousSecrets?.username),
            restoreSecret(secrets, secretKeys.cameraPassword(existing.id), previousSecrets?.password)
          ]);
          throw error;
        }
      }
      return view(parsed.camera);
    },

    async move(id: string, slotValue: unknown): Promise<CameraView> {
      let slot: CameraSlot;
      try { slot = parseCameraSlot(slotValue); }
      catch (error) { return invalid(error); }
      const existing = await camera(id);
      if (!await repository.moveToSlot(existing.id, slot)) throw new CameraDomainError("not_found", `Camera ${existing.id} was not found.`);
      return view((await repository.get(existing.id))!);
    },

    async delete(id: string): Promise<void> {
      const existing = await camera(id);
      const previousSecrets = await credentialState(secrets, existing.id);
      const wasSelected = config.console.selectedCameraId === existing.id;
      if (!await repository.delete(existing.id)) throw new CameraDomainError("not_found", `Camera ${existing.id} was not found.`);
      try {
        await secrets.delete(secretKeys.cameraUsername(existing.id));
        await secrets.delete(secretKeys.cameraPassword(existing.id));
        if (wasSelected) await persistSelection(undefined);
      } catch (error) {
        await repository.create(existing);
        await Promise.allSettled([
          restoreSecret(secrets, secretKeys.cameraUsername(existing.id), previousSecrets.username),
          restoreSecret(secrets, secretKeys.cameraPassword(existing.id), previousSecrets.password)
        ]);
        throw error;
      }
    },

    async test(id: string): Promise<CameraProbeResult> {
      return productionHealth(await camera(id));
    },

    async testDraft(value: unknown): Promise<CameraProbeResult> {
      let draft: ReturnType<typeof parseCameraTestDraft>;
      try { draft = parseCameraTestDraft(value, defaults); }
      catch (error) { return invalid(error); }
      return productionHealth(draft.camera, draft.credentials);
    },

    async discover(): Promise<readonly CamsnapCameraDescriptor[]> {
      try {
        return await runtime.withCamsnap(async (camsnapRuntime) => {
          const adapter = new CamsnapCameraAdapter({ cameras: [], runtime: camsnapRuntime });
          return adapter.discover();
        });
      } catch (error) {
        return runtimeError(error, "Camera discovery");
      }
    },

    async snapshot(id: string): Promise<InferenceImage> {
      const target = await camera(id);
      try {
        return await runtime.withCamsnap(async (camsnapRuntime) => {
          const adapter = new CamsnapCameraAdapter({ cameras: [target], runtime: camsnapRuntime });
          return adapter.snapshot(target.id);
        });
      } catch (error) {
        return runtimeError(error, "Camera snapshot");
      }
    },

    async clip(id: string, durationMs: number): Promise<CamsnapClip> {
      if (!Number.isInteger(durationMs) || durationMs <= 0) throw new CameraDomainError("invalid", "Camera clip durationMs must be a positive integer.");
      const target = await camera(id);
      try {
        return await runtime.withCamsnap(async (camsnapRuntime) => {
          const adapter = new CamsnapCameraAdapter({ cameras: [target], runtime: camsnapRuntime });
          return adapter.clip(target.id, durationMs);
        });
      } catch (error) {
        return runtimeError(error, "Camera clip");
      }
    },

    async selectedId(): Promise<string | undefined> {
      const selected = config.console.selectedCameraId ?? undefined;
      if (!selected) return undefined;
      if (await repository.get(selected)) return selected;
      await persistSelection(undefined);
      return undefined;
    },

    async select(id: string | undefined): Promise<void> {
      if (id !== undefined) await camera(id);
      await persistSelection(id);
    }
  };
}
