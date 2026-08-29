import type { InspectionCapability } from "@portus-qc/inspection-config";
import type { StateRepository } from "./repository";

export type ScheduleStatus = "completed" | "failed" | "dropped";

export interface StoredSchedule {
  id: string;
  cameraId: string;
  prompt: string;
  capability: InspectionCapability;
  intervalMs: number;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  lastFinishedAt?: string;
  lastStatus?: ScheduleStatus;
  lastResultId?: string;
  lastError?: string;
  droppedCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleRow {
  id: string;
  camera_id: string;
  prompt: string;
  capability: InspectionCapability;
  interval_ms: number;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_finished_at: string | null;
  last_status: string | null;
  last_result_id: string | null;
  last_error: string | null;
  dropped_count: number;
  created_at: string;
  updated_at: string;
}

const SELECT = `id, camera_id, prompt, capability, interval_ms, enabled, next_run_at, last_run_at,
  last_finished_at, last_status, last_result_id, last_error, dropped_count, created_at, updated_at`;

function fromRow(row: ScheduleRow): StoredSchedule {
  return {
    id: row.id,
    cameraId: row.camera_id,
    prompt: row.prompt,
    capability: row.capability,
    intervalMs: row.interval_ms,
    enabled: row.enabled === 1,
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
    ...(row.last_finished_at ? { lastFinishedAt: row.last_finished_at } : {}),
    ...(row.last_status ? { lastStatus: row.last_status as ScheduleStatus } : {}),
    ...(row.last_result_id ? { lastResultId: row.last_result_id } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    droppedCount: row.dropped_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface ScheduleWrite {
  id: string;
  cameraId: string;
  prompt: string;
  capability: InspectionCapability;
  intervalMs: number;
  enabled: boolean;
  nextRunAt?: string;
}

export interface ScheduleRepository {
  list(): Promise<readonly StoredSchedule[]>;
  get(id: string): Promise<StoredSchedule | undefined>;
  create(input: ScheduleWrite): Promise<boolean>;
  replace(input: ScheduleWrite): Promise<boolean>;
  setEnabled(id: string, enabled: boolean, nextRunAt?: string): Promise<boolean>;
  setNextRun(id: string, nextRunAt: string): Promise<boolean>;
  markStarted(id: string, at: string): Promise<boolean>;
  markCompleted(id: string, at: string, resultId: string): Promise<boolean>;
  markFailed(id: string, at: string, message: string): Promise<boolean>;
  markDropped(id: string, at: string): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

export class SqliteScheduleRepository implements ScheduleRepository {
  constructor(private readonly state: StateRepository, private readonly now: () => string = () => new Date().toISOString()) {}

  async list(): Promise<readonly StoredSchedule[]> {
    const rows = this.state.database.prepare(`SELECT ${SELECT} FROM schedules ORDER BY created_at, id`).all() as unknown as ScheduleRow[];
    return rows.map(fromRow);
  }

  async get(id: string): Promise<StoredSchedule | undefined> {
    const row = this.state.database.prepare(`SELECT ${SELECT} FROM schedules WHERE id = ?`).get(id) as unknown as ScheduleRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async create(input: ScheduleWrite): Promise<boolean> {
    const now = this.now();
    const result = this.state.database.prepare(`
      INSERT INTO schedules(id, camera_id, prompt, capability, interval_ms, enabled, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(input.id, input.cameraId, input.prompt, input.capability, input.intervalMs, input.enabled ? 1 : 0, input.nextRunAt ?? null, now, now);
    return Number(result.changes) > 0;
  }

  async replace(input: ScheduleWrite): Promise<boolean> {
    const result = this.state.database.prepare(`
      UPDATE schedules SET
        camera_id = ?, prompt = ?, capability = ?, interval_ms = ?, enabled = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(input.cameraId, input.prompt, input.capability, input.intervalMs, input.enabled ? 1 : 0, input.nextRunAt ?? null, this.now(), input.id);
    return Number(result.changes) > 0;
  }

  async setEnabled(id: string, enabled: boolean, nextRunAt?: string): Promise<boolean> {
    const result = this.state.database.prepare("UPDATE schedules SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, nextRunAt ?? null, this.now(), id);
    return Number(result.changes) > 0;
  }

  async setNextRun(id: string, nextRunAt: string): Promise<boolean> {
    const result = this.state.database.prepare("UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?").run(nextRunAt, this.now(), id);
    return Number(result.changes) > 0;
  }

  async markStarted(id: string, at: string): Promise<boolean> {
    const result = this.state.database.prepare("UPDATE schedules SET last_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(at, this.now(), id);
    return Number(result.changes) > 0;
  }

  async markCompleted(id: string, at: string, resultId: string): Promise<boolean> {
    const result = this.state.database.prepare(`
      UPDATE schedules SET last_finished_at = ?, last_status = 'completed', last_result_id = ?, last_error = NULL, updated_at = ? WHERE id = ?
    `).run(at, resultId, this.now(), id);
    return Number(result.changes) > 0;
  }

  async markFailed(id: string, at: string, message: string): Promise<boolean> {
    const result = this.state.database.prepare(`
      UPDATE schedules SET last_finished_at = ?, last_status = 'failed', last_result_id = NULL, last_error = ?, updated_at = ? WHERE id = ?
    `).run(at, message.slice(0, 1000), this.now(), id);
    return Number(result.changes) > 0;
  }

  async markDropped(id: string, at: string): Promise<boolean> {
    const result = this.state.database.prepare(`
      UPDATE schedules SET last_finished_at = ?, last_status = 'dropped', last_result_id = NULL,
        last_error = 'Scheduled cycle dropped because the previous cycle is still running.', dropped_count = dropped_count + 1, updated_at = ? WHERE id = ?
    `).run(at, this.now(), id);
    return Number(result.changes) > 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.state.database.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }
}
