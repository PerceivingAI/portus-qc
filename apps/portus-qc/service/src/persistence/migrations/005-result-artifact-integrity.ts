import type { DatabaseSync } from "node:sqlite";

function assertNoInvalidExistingRows(database: DatabaseSync): void {
  const missingSource = database.prepare(`
    SELECT id FROM results
    WHERE capability IN ('detect', 'segment', 'point')
      AND (source_media_ref IS NULL OR length(trim(source_media_ref)) = 0)
    LIMIT 1
  `).get();
  if (missingSource) throw new Error("Cannot apply result artifact integrity migration: a spatial result is missing source media.");

  const zeroBox = database.prepare(`
    SELECT result_id FROM result_boxes
    WHERE x_min >= x_max OR y_min >= y_max
    LIMIT 1
  `).get();
  if (zeroBox) throw new Error("Cannot apply result artifact integrity migration: a Detect box has zero area.");

  const invalidSegment = database.prepare(`
    SELECT result_id FROM result_segment_regions
    WHERE bbox_x_min IS NULL OR bbox_y_min IS NULL OR bbox_x_max IS NULL OR bbox_y_max IS NULL
       OR bbox_x_min >= bbox_x_max OR bbox_y_min >= bbox_y_max
    LIMIT 1
  `).get();
  if (invalidSegment) throw new Error("Cannot apply result artifact integrity migration: a Segment region is missing a positive-area bounding box.");
}

export const resultArtifactIntegrityMigration = {
  version: 5,
  up(database: DatabaseSync): void {
    assertNoInvalidExistingRows(database);
    database.exec(`
      CREATE TRIGGER results_spatial_source_guard_insert
      BEFORE INSERT ON results
      WHEN NEW.capability IN ('detect', 'segment', 'point')
        AND (NEW.source_media_ref IS NULL OR length(trim(NEW.source_media_ref)) = 0)
      BEGIN
        SELECT RAISE(ABORT, 'spatial results require source media');
      END;

      CREATE TRIGGER results_spatial_source_guard_update
      BEFORE UPDATE OF capability, source_media_ref ON results
      WHEN NEW.capability IN ('detect', 'segment', 'point')
        AND (NEW.source_media_ref IS NULL OR length(trim(NEW.source_media_ref)) = 0)
      BEGIN
        SELECT RAISE(ABORT, 'spatial results require source media');
      END;

      CREATE TRIGGER result_boxes_positive_area_insert
      BEFORE INSERT ON result_boxes
      WHEN NEW.x_min >= NEW.x_max OR NEW.y_min >= NEW.y_max
      BEGIN
        SELECT RAISE(ABORT, 'result_boxes requires positive area');
      END;

      CREATE TRIGGER result_boxes_positive_area_update
      BEFORE UPDATE OF x_min, y_min, x_max, y_max ON result_boxes
      WHEN NEW.x_min >= NEW.x_max OR NEW.y_min >= NEW.y_max
      BEGIN
        SELECT RAISE(ABORT, 'result_boxes requires positive area');
      END;

      CREATE TRIGGER result_segment_bbox_guard_insert
      BEFORE INSERT ON result_segment_regions
      WHEN NEW.bbox_x_min IS NULL OR NEW.bbox_y_min IS NULL OR NEW.bbox_x_max IS NULL OR NEW.bbox_y_max IS NULL
        OR NEW.bbox_x_min >= NEW.bbox_x_max OR NEW.bbox_y_min >= NEW.bbox_y_max
      BEGIN
        SELECT RAISE(ABORT, 'segment regions require a positive-area bounding box');
      END;

      CREATE TRIGGER result_segment_bbox_guard_update
      BEFORE UPDATE OF bbox_x_min, bbox_y_min, bbox_x_max, bbox_y_max ON result_segment_regions
      WHEN NEW.bbox_x_min IS NULL OR NEW.bbox_y_min IS NULL OR NEW.bbox_x_max IS NULL OR NEW.bbox_y_max IS NULL
        OR NEW.bbox_x_min >= NEW.bbox_x_max OR NEW.bbox_y_min >= NEW.bbox_y_max
      BEGIN
        SELECT RAISE(ABORT, 'segment regions require a positive-area bounding box');
      END;
    `);
  }
} as const;
