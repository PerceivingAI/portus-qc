import type { DatabaseSync } from "node:sqlite";

export const camerasMigration = {
  version: 6,
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE cameras (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER CHECK (port IS NULL OR (port >= 1 AND port <= 65535)),
        protocol TEXT NOT NULL CHECK (protocol IN ('rtsp', 'rtsps')),
        stream TEXT NOT NULL CHECK (stream IN ('stream1', 'stream2')),
        path TEXT,
        transport TEXT NOT NULL CHECK (transport IN ('tcp', 'udp')),
        rtsp_client TEXT NOT NULL CHECK (rtsp_client IN ('gortsplib', 'ffmpeg')),
        rtsp_auth TEXT NOT NULL CHECK (rtsp_auth IN ('auto', 'basic', 'digest')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (length(trim(id)) > 0),
        CHECK (length(trim(name)) > 0),
        CHECK (length(trim(host)) > 0),
        CHECK (path IS NULL OR length(trim(path)) > 0)
      );

      CREATE INDEX cameras_name_idx ON cameras(name COLLATE NOCASE, id);
      CREATE INDEX cameras_host_idx ON cameras(host, port);
    `);
  }
} as const;
