import type { DatabaseSync } from "node:sqlite";

export const resultsMigration = {
  version: 4,
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE results (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        camera_id TEXT,
        source_id TEXT NOT NULL,
        inspection_id TEXT NOT NULL,
        inspection_name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        capability TEXT NOT NULL CHECK (capability IN ('query', 'detect', 'segment', 'point', 'caption')),
        input_mode TEXT NOT NULL CHECK (input_mode IN ('image', 'video-frame')),
        trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('on-demand', 'scheduled')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        request_id TEXT,
        duration_ms REAL CHECK (duration_ms IS NULL OR duration_ms >= 0),
        text_result TEXT,
        source_media_ref TEXT,
        artifact_ref TEXT,
        CHECK (
          (capability IN ('query', 'caption') AND text_result IS NOT NULL AND length(trim(text_result)) > 0)
          OR
          (capability IN ('detect', 'segment', 'point') AND text_result IS NULL)
        )
      );

      CREATE TABLE result_boxes (
        result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        x_min REAL NOT NULL CHECK (x_min >= 0 AND x_min <= 1),
        y_min REAL NOT NULL CHECK (y_min >= 0 AND y_min <= 1),
        x_max REAL NOT NULL CHECK (x_max >= 0 AND x_max <= 1),
        y_max REAL NOT NULL CHECK (y_max >= 0 AND y_max <= 1),
        PRIMARY KEY (result_id, ordinal),
        CHECK (x_min <= x_max AND y_min <= y_max)
      );

      CREATE TABLE result_points (
        result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        x REAL NOT NULL CHECK (x >= 0 AND x <= 1),
        y REAL NOT NULL CHECK (y >= 0 AND y <= 1),
        PRIMARY KEY (result_id, ordinal)
      );

      CREATE TABLE result_segment_regions (
        result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        path TEXT NOT NULL CHECK (length(trim(path)) > 0),
        bbox_x_min REAL,
        bbox_y_min REAL,
        bbox_x_max REAL,
        bbox_y_max REAL,
        PRIMARY KEY (result_id, ordinal),
        CHECK (
          (bbox_x_min IS NULL AND bbox_y_min IS NULL AND bbox_x_max IS NULL AND bbox_y_max IS NULL)
          OR
          (
            bbox_x_min IS NOT NULL AND bbox_y_min IS NOT NULL AND bbox_x_max IS NOT NULL AND bbox_y_max IS NOT NULL
            AND bbox_x_min >= 0 AND bbox_x_min <= 1
            AND bbox_y_min >= 0 AND bbox_y_min <= 1
            AND bbox_x_max >= 0 AND bbox_x_max <= 1
            AND bbox_y_max >= 0 AND bbox_y_max <= 1
            AND bbox_x_min <= bbox_x_max
            AND bbox_y_min <= bbox_y_max
          )
        )
      );

      CREATE TRIGGER result_boxes_capability_guard
      BEFORE INSERT ON result_boxes
      WHEN (SELECT capability FROM results WHERE id = NEW.result_id) <> 'detect'
      BEGIN
        SELECT RAISE(ABORT, 'result_boxes requires detect capability');
      END;

      CREATE TRIGGER result_points_capability_guard
      BEFORE INSERT ON result_points
      WHEN (SELECT capability FROM results WHERE id = NEW.result_id) <> 'point'
      BEGIN
        SELECT RAISE(ABORT, 'result_points requires point capability');
      END;

      CREATE TRIGGER result_segment_regions_capability_guard
      BEFORE INSERT ON result_segment_regions
      WHEN (SELECT capability FROM results WHERE id = NEW.result_id) <> 'segment'
      BEGIN
        SELECT RAISE(ABORT, 'result_segment_regions requires segment capability');
      END;

      CREATE INDEX results_created_at_idx ON results(created_at DESC, id);
      CREATE INDEX results_inspection_created_idx ON results(inspection_id, created_at DESC);
      CREATE INDEX results_camera_created_idx ON results(camera_id, created_at DESC);
      CREATE INDEX results_capability_created_idx ON results(capability, created_at DESC);
    `);
  }
} as const;
