import type { DatabaseSync } from "node:sqlite";

interface LegacyCameraRow {
  id: string;
  name: string;
  host: string;
  port: number | null;
  protocol: string;
  stream: string;
  path: string | null;
  transport: string;
  rtsp_client: string;
  rtsp_auth: string;
  created_at: string;
  updated_at: string;
}

export const cameraSlotsMigration = {
  version: 7,
  up(database: DatabaseSync): void {
    const rows = database.prepare(`
      SELECT id, name, host, port, protocol, stream, path, transport, rtsp_client, rtsp_auth, created_at, updated_at
      FROM cameras ORDER BY name COLLATE NOCASE, id
    `).all() as unknown as LegacyCameraRow[];
    if (rows.length > 4) throw new Error("Portus QC supports at most four cameras. Remove cameras until four or fewer remain before upgrading.");

    database.exec(`
      CREATE TABLE cameras_v7 (
        id TEXT PRIMARY KEY,
        slot INTEGER NOT NULL UNIQUE CHECK (slot >= 1 AND slot <= 4),
        alias TEXT CHECK (alias IS NULL OR length(trim(alias)) > 0),
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
        CHECK (length(trim(host)) > 0),
        CHECK (path IS NULL OR length(trim(path)) > 0)
      );
    `);

    const insert = database.prepare(`
      INSERT INTO cameras_v7(
        id, slot, alias, host, port, protocol, stream, path, transport, rtsp_client, rtsp_auth, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    rows.forEach((row, index) => {
      const id = String(row.id);
      const legacyName = String(row.name);
      insert.run(
        id,
        index + 1,
        legacyName.trim() === id ? null : legacyName,
        row.host,
        row.port,
        row.protocol,
        row.stream,
        row.path,
        row.transport,
        row.rtsp_client,
        row.rtsp_auth,
        row.created_at,
        row.updated_at
      );
    });

    database.exec(`
      DROP INDEX cameras_name_idx;
      DROP INDEX cameras_host_idx;
      DROP TABLE cameras;
      ALTER TABLE cameras_v7 RENAME TO cameras;
      CREATE INDEX cameras_host_idx ON cameras(host, port);
    `);
  }
} as const;
