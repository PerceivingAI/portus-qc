import type {
  BoxGeometry,
  DetectResult,
  MaskGeometry,
  PointGeometry,
  PointResult,
  SegmentResult,
  VisionCapability,
  VisionResult
} from "@portus-qc/contracts";
import type { StateRepository } from "./repository";

export type ResultInputMode = "image" | "video-frame";
export type ResultTriggerMode = "on-demand" | "scheduled";

export interface StoredInspectionResult {
  id: string;
  createdAt: string;
  cameraId?: string;
  sourceId: string;
  inspectionId: string;
  inspectionName: string;
  prompt: string;
  capability: VisionCapability;
  inputMode: ResultInputMode;
  triggerMode: ResultTriggerMode;
  provider: string;
  model: string;
  requestId?: string;
  durationMs?: number;
  result: VisionResult;
  sourceMediaRef?: string;
  artifactRef?: string;
}

interface ResultRow {
  id: unknown;
  created_at: unknown;
  camera_id: unknown;
  source_id: unknown;
  inspection_id: unknown;
  inspection_name: unknown;
  prompt: unknown;
  capability: unknown;
  input_mode: unknown;
  trigger_mode: unknown;
  provider: unknown;
  model: unknown;
  request_id: unknown;
  duration_ms: unknown;
  text_result: unknown;
  source_media_ref: unknown;
  artifact_ref: unknown;
}

export interface ResultRepository {
  create(result: StoredInspectionResult): Promise<boolean>;
  get(id: string): Promise<StoredInspectionResult | undefined>;
  listRecent(limit?: number): Promise<readonly StoredInspectionResult[]>;
  setArtifactReference(id: string, artifactRef: string): Promise<boolean>;
}

const CAPABILITIES = new Set<VisionCapability>(["query", "detect", "segment", "point", "caption"]);
const INPUT_MODES = new Set<ResultInputMode>(["image", "video-frame"]);
const TRIGGER_MODES = new Set<ResultTriggerMode>(["on-demand", "scheduled"]);

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty.`);
  if (normalized.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters.`);
  return normalized;
}

function optionalText(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, name, maxLength);
}

function timestamp(value: unknown): string {
  const text = requiredText(value, "Result createdAt", 100);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error("Result createdAt must be a valid timestamp.");
  return date.toISOString();
}

function coordinate(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite normalized coordinate from 0 to 1.`);
  }
  return value;
}

function box(value: BoxGeometry, name: string): BoxGeometry {
  const xMin = coordinate(value?.xMin, `${name}.xMin`);
  const yMin = coordinate(value?.yMin, `${name}.yMin`);
  const xMax = coordinate(value?.xMax, `${name}.xMax`);
  const yMax = coordinate(value?.yMax, `${name}.yMax`);
  if (xMin >= xMax || yMin >= yMax) throw new Error(`${name} must have positive width and height.`);
  return { xMin, yMin, xMax, yMax };
}

function point(value: PointGeometry, name: string): PointGeometry {
  return { x: coordinate(value?.x, `${name}.x`), y: coordinate(value?.y, `${name}.y`) };
}

function region(value: MaskGeometry, name: string): MaskGeometry {
  const path = requiredText(value?.path, `${name}.path`, 2_000_000);
  return { path, ...(value.bbox ? { bbox: box(value.bbox, `${name}.bbox`) } : {}) };
}

function normalizeVisionResult(value: VisionResult, capability: VisionCapability): VisionResult {
  if (!value || typeof value !== "object" || value.capability !== capability) {
    throw new Error("Stored result capability must match its normalized vision result.");
  }
  switch (capability) {
    case "query":
    case "caption":
      return { capability, text: requiredText((value as { text?: unknown }).text, "Result text", 1_000_000) };
    case "detect": {
      const boxes = (value as DetectResult).boxes;
      if (!Array.isArray(boxes)) throw new Error("Detect result boxes must be an array.");
      return { capability, boxes: boxes.map((item, index) => box(item, `Detect box ${index}`)) };
    }
    case "point": {
      const points = (value as PointResult).points;
      if (!Array.isArray(points)) throw new Error("Point result points must be an array.");
      return { capability, points: points.map((item, index) => point(item, `Point ${index}`)) };
    }
    case "segment": {
      const regions = (value as SegmentResult).regions;
      if (!Array.isArray(regions)) throw new Error("Segment result regions must be an array.");
      return {
        capability,
        regions: regions.map((item, index) => {
          if (!item?.bbox) throw new Error(`Segment region ${index} requires a normalized bounding box for local rendering.`);
          return region(item, `Segment region ${index}`);
        })
      };
    }
  }
}

function normalizeStoredResult(value: StoredInspectionResult): StoredInspectionResult {
  if (!value || typeof value !== "object") throw new Error("Stored result must be an object.");
  const capability = value.capability;
  if (!CAPABILITIES.has(capability)) throw new Error("Result capability is invalid.");
  if (!INPUT_MODES.has(value.inputMode)) throw new Error("Result inputMode must be image or video-frame.");
  if (!TRIGGER_MODES.has(value.triggerMode)) throw new Error("Result triggerMode must be on-demand or scheduled.");
  const durationMs = value.durationMs;
  if (durationMs !== undefined && (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)) {
    throw new Error("Result durationMs must be a finite non-negative number.");
  }
  const cameraId = optionalText(value.cameraId, "Result cameraId", 120);
  const requestId = optionalText(value.requestId, "Result requestId", 500);
  const sourceMediaRef = optionalText(value.sourceMediaRef, "Result sourceMediaRef", 4096);
  const artifactRef = optionalText(value.artifactRef, "Result artifactRef", 4096);
  if ((capability === "detect" || capability === "segment" || capability === "point") && sourceMediaRef === undefined) {
    throw new Error("Spatial results require a retained sourceMediaRef for rendering and history reconstruction.");
  }
  return {
    id: requiredText(value.id, "Result id", 120),
    createdAt: timestamp(value.createdAt),
    ...(cameraId !== undefined ? { cameraId } : {}),
    sourceId: requiredText(value.sourceId, "Result sourceId", 200),
    inspectionId: requiredText(value.inspectionId, "Result inspectionId", 80),
    inspectionName: requiredText(value.inspectionName, "Result inspectionName", 120),
    prompt: requiredText(value.prompt, "Result prompt", 4000),
    capability,
    inputMode: value.inputMode,
    triggerMode: value.triggerMode,
    provider: requiredText(value.provider, "Result provider", 120),
    model: requiredText(value.model, "Result model", 200),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    result: normalizeVisionResult(value.result, capability),
    ...(sourceMediaRef !== undefined ? { sourceMediaRef } : {}),
    ...(artifactRef !== undefined ? { artifactRef } : {})
  };
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class SqliteResultRepository implements ResultRepository {
  constructor(private readonly state: StateRepository) {}

  async create(input: StoredInspectionResult): Promise<boolean> {
    const value = normalizeStoredResult(input);
    const textResult = value.result.capability === "query" || value.result.capability === "caption" ? value.result.text : null;
    const database = this.state.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = database.prepare(`
        INSERT INTO results(
          id, created_at, camera_id, source_id, inspection_id, inspection_name, prompt, capability,
          input_mode, trigger_mode, provider, model, request_id, duration_ms, text_result,
          source_media_ref, artifact_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(
        value.id,
        value.createdAt,
        value.cameraId ?? null,
        value.sourceId,
        value.inspectionId,
        value.inspectionName,
        value.prompt,
        value.capability,
        value.inputMode,
        value.triggerMode,
        value.provider,
        value.model,
        value.requestId ?? null,
        value.durationMs ?? null,
        textResult,
        value.sourceMediaRef ?? null,
        value.artifactRef ?? null
      );
      if (Number(inserted.changes) === 0) {
        database.exec("ROLLBACK");
        return false;
      }

      if (value.result.capability === "detect") {
        const insert = database.prepare("INSERT INTO result_boxes(result_id, ordinal, x_min, y_min, x_max, y_max) VALUES (?, ?, ?, ?, ?, ?)");
        value.result.boxes.forEach((item, index) => insert.run(value.id, index, item.xMin, item.yMin, item.xMax, item.yMax));
      } else if (value.result.capability === "point") {
        const insert = database.prepare("INSERT INTO result_points(result_id, ordinal, x, y) VALUES (?, ?, ?, ?)");
        value.result.points.forEach((item, index) => insert.run(value.id, index, item.x, item.y));
      } else if (value.result.capability === "segment") {
        const insert = database.prepare(`
          INSERT INTO result_segment_regions(
            result_id, ordinal, path, bbox_x_min, bbox_y_min, bbox_x_max, bbox_y_max
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        value.result.regions.forEach((item, index) => insert.run(
          value.id,
          index,
          item.path,
          item.bbox?.xMin ?? null,
          item.bbox?.yMin ?? null,
          item.bbox?.xMax ?? null,
          item.bbox?.yMax ?? null
        ));
      }

      database.exec("COMMIT");
      return true;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async get(id: string): Promise<StoredInspectionResult | undefined> {
    const normalizedId = requiredText(id, "Result id", 120);
    const row = this.state.database.prepare(`
      SELECT id, created_at, camera_id, source_id, inspection_id, inspection_name, prompt, capability,
             input_mode, trigger_mode, provider, model, request_id, duration_ms, text_result,
             source_media_ref, artifact_ref
      FROM results WHERE id = ?
    `).get(normalizedId) as unknown as ResultRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  async listRecent(limit = 100): Promise<readonly StoredInspectionResult[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Result list limit must be an integer from 1 to 1000.");
    const rows = this.state.database.prepare(`
      SELECT id, created_at, camera_id, source_id, inspection_id, inspection_name, prompt, capability,
             input_mode, trigger_mode, provider, model, request_id, duration_ms, text_result,
             source_media_ref, artifact_ref
      FROM results
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit) as unknown as ResultRow[];
    return rows.map((row) => this.fromRow(row));
  }

  async setArtifactReference(id: string, artifactRef: string): Promise<boolean> {
    const result = this.state.database.prepare("UPDATE results SET artifact_ref = ? WHERE id = ?").run(
      requiredText(artifactRef, "Result artifactRef", 4096),
      requiredText(id, "Result id", 120)
    );
    return Number(result.changes) > 0;
  }

  private fromRow(row: ResultRow): StoredInspectionResult {
    const id = requiredText(row.id, "Stored result id", 120);
    const capability = requiredText(row.capability, "Stored capability", 20) as VisionCapability;
    if (!CAPABILITIES.has(capability)) throw new Error("Stored result capability is invalid.");
    let result: VisionResult;

    if (capability === "query" || capability === "caption") {
      result = { capability, text: requiredText(row.text_result, "Stored result text", 1_000_000) };
    } else if (capability === "detect") {
      const rows = this.state.database.prepare(`
        SELECT x_min, y_min, x_max, y_max FROM result_boxes WHERE result_id = ? ORDER BY ordinal
      `).all(id) as Array<{ x_min: number; y_min: number; x_max: number; y_max: number }>;
      result = { capability, boxes: rows.map((item, index) => box({ xMin: item.x_min, yMin: item.y_min, xMax: item.x_max, yMax: item.y_max }, `Stored detect box ${index}`)) };
    } else if (capability === "point") {
      const rows = this.state.database.prepare(`
        SELECT x, y FROM result_points WHERE result_id = ? ORDER BY ordinal
      `).all(id) as Array<{ x: number; y: number }>;
      result = { capability, points: rows.map((item, index) => point(item, `Stored point ${index}`)) };
    } else {
      const rows = this.state.database.prepare(`
        SELECT path, bbox_x_min, bbox_y_min, bbox_x_max, bbox_y_max
        FROM result_segment_regions WHERE result_id = ? ORDER BY ordinal
      `).all(id) as Array<{
        path: string;
        bbox_x_min: number | null;
        bbox_y_min: number | null;
        bbox_x_max: number | null;
        bbox_y_max: number | null;
      }>;
      result = {
        capability,
        regions: rows.map((item, index) => {
          const hasBbox = item.bbox_x_min !== null;
          const value: MaskGeometry = {
            path: item.path,
            ...(hasBbox ? { bbox: { xMin: item.bbox_x_min!, yMin: item.bbox_y_min!, xMax: item.bbox_x_max!, yMax: item.bbox_y_max! } } : {})
          };
          return region(value, `Stored segment region ${index}`);
        })
      };
    }

    const cameraId = nullableString(row.camera_id);
    const requestId = nullableString(row.request_id);
    const durationMs = numeric(row.duration_ms);
    const sourceMediaRef = nullableString(row.source_media_ref);
    const artifactRef = nullableString(row.artifact_ref);
    return normalizeStoredResult({
      id,
      createdAt: timestamp(row.created_at),
      ...(cameraId !== undefined ? { cameraId } : {}),
      sourceId: requiredText(row.source_id, "Stored sourceId", 200),
      inspectionId: requiredText(row.inspection_id, "Stored inspectionId", 80),
      inspectionName: requiredText(row.inspection_name, "Stored inspectionName", 120),
      prompt: requiredText(row.prompt, "Stored prompt", 4000),
      capability,
      inputMode: requiredText(row.input_mode, "Stored inputMode", 20) as ResultInputMode,
      triggerMode: requiredText(row.trigger_mode, "Stored triggerMode", 20) as ResultTriggerMode,
      provider: requiredText(row.provider, "Stored provider", 120),
      model: requiredText(row.model, "Stored model", 200),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      result,
      ...(sourceMediaRef !== undefined ? { sourceMediaRef } : {}),
      ...(artifactRef !== undefined ? { artifactRef } : {})
    });
  }
}
