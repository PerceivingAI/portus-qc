import { randomUUID } from "node:crypto";
import { compileInspectionDefinition, InspectionConfigError, type InspectionCapability } from "@portus-qc/inspection-config";
import type { SchedulerConfig } from "../../../config/schema";
import type { CameraService } from "./cameras";
import { CameraDomainError } from "./cameras";
import type { InspectionRunService } from "./inspection-runs";
import type { ScheduleRepository, StoredSchedule } from "../persistence/schedules";

export const MAX_SCHEDULED_TASKS = 10;

export type ScheduleDomainErrorCode = "invalid" | "not_found" | "camera_not_found" | "limit" | "conflict";

export class ScheduleDomainError extends Error {
  constructor(readonly code: ScheduleDomainErrorCode, message: string) {
    super(message);
    this.name = "ScheduleDomainError";
  }
}

export interface ScheduleView extends StoredSchedule {}
export interface SchedulePolicy extends SchedulerConfig { maxSchedules: number; }

export interface ScheduleTimerDriver {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface ScheduleService {
  policy(): SchedulePolicy;
  list(): Promise<readonly ScheduleView[]>;
  create(input: unknown): Promise<ScheduleView>;
  replace(id: string, input: unknown): Promise<ScheduleView>;
  setEnabled(id: string, enabled: boolean): Promise<ScheduleView>;
  delete(id: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ParsedScheduleInput {
  cameraId: string;
  prompt: string;
  capability: InspectionCapability;
  intervalMs: number;
  enabled: boolean;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ScheduleDomainError("invalid", `${name} must be a non-empty string.`);
  return value.trim();
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new ScheduleDomainError("invalid", `${name} must be a boolean.`);
  return value;
}

function interval(value: unknown, config: SchedulerConfig): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < config.minIntervalMs || value > config.maxIntervalMs) {
    throw new ScheduleDomainError("invalid", `intervalMs must be an integer from ${config.minIntervalMs} to ${config.maxIntervalMs}.`);
  }
  return value;
}

function parseInput(value: unknown, config: SchedulerConfig): ParsedScheduleInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScheduleDomainError("invalid", "Schedule body must be an object.");
  const record = value as Record<string, unknown>;
  const extras = Object.keys(record).filter((key) => !["cameraId", "prompt", "capability", "intervalMs", "enabled"].includes(key));
  if (extras.length) throw new ScheduleDomainError("invalid", `Schedule body contains unsupported field(s): ${extras.join(", ")}.`);
  const cameraId = requiredText(record.cameraId, "cameraId");
  let definition;
  try {
    definition = compileInspectionDefinition({
      id: "scheduled-task-validation",
      name: "Scheduled task",
      prompt: record.prompt,
      capability: record.capability
    });
  } catch (error) {
    if (error instanceof InspectionConfigError) throw new ScheduleDomainError("invalid", error.message);
    throw error;
  }
  return {
    cameraId,
    prompt: definition.prompt,
    capability: definition.capability,
    intervalMs: interval(record.intervalMs, config),
    enabled: bool(record.enabled, "enabled")
  };
}

function scheduleIdInput(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ScheduleDomainError("invalid", "schedule id must not be empty.");
  return normalized;
}

function id(): string { return `schedule_${randomUUID()}`; }
function iso(date: Date): string { return date.toISOString(); }
function validDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function createScheduleService(input: {
  repository: ScheduleRepository;
  cameras: CameraService;
  runs: InspectionRunService;
  config: SchedulerConfig;
  now?: () => Date;
  idFactory?: () => string;
  timers?: ScheduleTimerDriver;
  onError?: (error: unknown) => void;
}): ScheduleService {
  const now = input.now ?? (() => new Date());
  const makeId = input.idFactory ?? id;
  const timers: ScheduleTimerDriver = input.timers ?? {
    set(callback, delayMs) {
      const handle = setTimeout(callback, delayMs);
      handle.unref();
      return handle;
    },
    clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); }
  };
  const handles = new Map<string, unknown>();
  const inFlight = new Map<string, Promise<void>>();
  let started = false;
  let stopping = false;

  function clearTimer(scheduleId: string): void {
    const handle = handles.get(scheduleId);
    if (handle !== undefined) timers.clear(handle);
    handles.delete(scheduleId);
  }

  function nextAt(intervalMs: number): string { return iso(new Date(now().getTime() + intervalMs)); }

  async function validateCamera(cameraId: string): Promise<void> {
    try { await input.cameras.get(cameraId); }
    catch (error) {
      if (error instanceof CameraDomainError && error.code === "not_found") throw new ScheduleDomainError("camera_not_found", error.message);
      throw error;
    }
  }

  async function requiredSchedule(scheduleId: string): Promise<StoredSchedule> {
    const schedule = await input.repository.get(scheduleIdInput(scheduleId));
    if (!schedule) throw new ScheduleDomainError("not_found", `Schedule ${scheduleId} was not found.`);
    return schedule;
  }

  async function arm(schedule: StoredSchedule, keepFuture = true): Promise<void> {
    clearTimer(schedule.id);
    if (!started || stopping || !schedule.enabled) return;
    const current = now();
    const persisted = keepFuture ? validDate(schedule.nextRunAt) : undefined;
    const due = persisted && persisted.getTime() > current.getTime() ? persisted : new Date(current.getTime() + schedule.intervalMs);
    const dueIso = iso(due);
    if (schedule.nextRunAt !== dueIso) await input.repository.setNextRun(schedule.id, dueIso);
    const delay = Math.max(0, due.getTime() - now().getTime());
    handles.set(schedule.id, timers.set(() => {
      void dueSchedule(schedule.id).catch((error) => input.onError?.(error));
    }, delay));
  }

  async function dueSchedule(scheduleId: string): Promise<void> {
    handles.delete(scheduleId);
    if (!started || stopping) return;
    const schedule = await input.repository.get(scheduleId);
    if (!schedule?.enabled) return;

    const following = nextAt(schedule.intervalMs);
    await input.repository.setNextRun(schedule.id, following);
    await arm({ ...schedule, nextRunAt: following });

    if (inFlight.has(schedule.id)) {
      await input.repository.markDropped(schedule.id, iso(now()));
      return;
    }

    const job = (async () => {
      const startedAt = iso(now());
      await input.repository.markStarted(schedule.id, startedAt);
      try {
        const run = await input.runs.runScheduledTask({
          cameraId: schedule.cameraId,
          scheduleId: schedule.id,
          prompt: schedule.prompt,
          capability: schedule.capability
        });
        await input.repository.markCompleted(schedule.id, iso(now()), run.result.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Scheduled inspection failed.";
        await input.repository.markFailed(schedule.id, iso(now()), message);
      }
    })().finally(() => { inFlight.delete(schedule.id); });
    inFlight.set(schedule.id, job);
  }

  return {
    policy(): SchedulePolicy { return { ...input.config, maxSchedules: MAX_SCHEDULED_TASKS }; },

    list(): Promise<readonly ScheduleView[]> { return input.repository.list(); },

    async create(value: unknown): Promise<ScheduleView> {
      const parsed = parseInput(value, input.config);
      await validateCamera(parsed.cameraId);
      if ((await input.repository.list()).length >= MAX_SCHEDULED_TASKS) {
        throw new ScheduleDomainError("limit", `Portus QC supports up to ${MAX_SCHEDULED_TASKS} scheduled tasks.`);
      }
      const scheduleId = makeId();
      const nextRunAt = parsed.enabled ? nextAt(parsed.intervalMs) : undefined;
      if (!await input.repository.create({ id: scheduleId, ...parsed, ...(nextRunAt ? { nextRunAt } : {}) })) {
        throw new ScheduleDomainError("conflict", `Schedule ${scheduleId} already exists.`);
      }
      const stored = await requiredSchedule(scheduleId);
      if (started && stored.enabled) await arm(stored, false);
      return await requiredSchedule(scheduleId);
    },

    async replace(scheduleIdValue: string, value: unknown): Promise<ScheduleView> {
      const scheduleId = scheduleIdInput(scheduleIdValue);
      await requiredSchedule(scheduleId);
      const parsed = parseInput(value, input.config);
      await validateCamera(parsed.cameraId);
      const nextRunAt = parsed.enabled ? nextAt(parsed.intervalMs) : undefined;
      if (!await input.repository.replace({ id: scheduleId, ...parsed, ...(nextRunAt ? { nextRunAt } : {}) })) {
        throw new ScheduleDomainError("not_found", `Schedule ${scheduleId} was not found.`);
      }
      clearTimer(scheduleId);
      const stored = await requiredSchedule(scheduleId);
      if (started && stored.enabled) await arm(stored, false);
      return await requiredSchedule(scheduleId);
    },

    async setEnabled(scheduleIdValue: string, enabled: boolean): Promise<ScheduleView> {
      if (typeof enabled !== "boolean") throw new ScheduleDomainError("invalid", "enabled must be a boolean.");
      const schedule = await requiredSchedule(scheduleIdInput(scheduleIdValue));
      const nextRunAt = enabled ? nextAt(schedule.intervalMs) : undefined;
      if (!await input.repository.setEnabled(schedule.id, enabled, nextRunAt)) {
        throw new ScheduleDomainError("not_found", `Schedule ${schedule.id} was not found.`);
      }
      clearTimer(schedule.id);
      const stored = await requiredSchedule(schedule.id);
      if (started && stored.enabled) await arm(stored, false);
      return await requiredSchedule(schedule.id);
    },

    async delete(scheduleIdValue: string): Promise<void> {
      const scheduleId = scheduleIdInput(scheduleIdValue);
      await requiredSchedule(scheduleId);
      clearTimer(scheduleId);
      if (!await input.repository.delete(scheduleId)) throw new ScheduleDomainError("not_found", `Schedule ${scheduleId} was not found.`);
    },

    async start(): Promise<void> {
      if (started) return;
      started = true;
      stopping = false;
      for (const schedule of await input.repository.list()) if (schedule.enabled) await arm(schedule, true);
    },

    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      started = false;
      for (const scheduleId of handles.keys()) clearTimer(scheduleId);
      await Promise.allSettled([...inFlight.values()]);
      inFlight.clear();
    }
  };
}
