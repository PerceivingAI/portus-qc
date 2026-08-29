import { parseCamera, type Camera, type CameraSlot } from "../../../config/camera";
import type { CameraDefaults } from "../../../config/schema";
import type { StateRepository } from "./repository";

interface CameraRow {
  id: string;
  slot: number;
  alias: string | null;
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
const SELECT_COLUMNS = "id, slot, alias, host, port, protocol, stream, path, transport, rtsp_client, rtsp_auth";

export interface CameraRepository {
  list(): Promise<readonly Camera[]>;
  get(id: string): Promise<Camera | undefined>;
  getBySlot(slot: CameraSlot): Promise<Camera | undefined>;
  create(camera: Camera): Promise<boolean>;
  replace(camera: Camera): Promise<boolean>;
  moveToSlot(id: string, slot: CameraSlot): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

export class SqliteCameraRepository implements CameraRepository {
  constructor(
    private readonly state: StateRepository,
    private readonly defaults: CameraDefaults,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  private fromRow(row: CameraRow): Camera {
    return parseCamera({
      id: row.id,
      slot: row.slot,
      ...(typeof row.alias === "string" ? { alias: row.alias } : {}),
      host: row.host,
      ...(typeof row.port === "number" ? { port: row.port } : {}),
      protocol: row.protocol,
      stream: row.stream,
      ...(typeof row.path === "string" ? { path: row.path } : {}),
      transport: row.transport,
      rtspClient: row.rtsp_client,
      rtspAuth: row.rtsp_auth
    }, this.defaults);
  }

  async list(): Promise<readonly Camera[]> {
    const rows = this.state.database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM cameras ORDER BY slot
    `).all() as unknown as CameraRow[];
    return rows.map((row) => this.fromRow(row));
  }

  async get(id: string): Promise<Camera | undefined> {
    const row = this.state.database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM cameras WHERE id = ?
    `).get(id) as unknown as CameraRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  async getBySlot(slot: CameraSlot): Promise<Camera | undefined> {
    const row = this.state.database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM cameras WHERE slot = ?
    `).get(slot) as unknown as CameraRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  async create(input: Camera): Promise<boolean> {
    const camera = parseCamera(input, this.defaults);
    const now = this.now();
    const result = this.state.database.prepare(`
      INSERT INTO cameras(
        id, slot, alias, host, port, protocol, stream, path, transport, rtsp_client, rtsp_auth, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      camera.id, camera.slot, camera.alias ?? null, camera.host, camera.port ?? null, camera.protocol, camera.stream, camera.path ?? null,
      camera.transport, camera.rtspClient, camera.rtspAuth, now, now
    );
    return Number(result.changes) > 0;
  }

  async replace(input: Camera): Promise<boolean> {
    const camera = parseCamera(input, this.defaults);
    const result = this.state.database.prepare(`
      UPDATE cameras SET
        slot = ?, alias = ?, host = ?, port = ?, protocol = ?, stream = ?, path = ?, transport = ?,
        rtsp_client = ?, rtsp_auth = ?, updated_at = ?
      WHERE id = ?
    `).run(
      camera.slot, camera.alias ?? null, camera.host, camera.port ?? null, camera.protocol, camera.stream, camera.path ?? null,
      camera.transport, camera.rtspClient, camera.rtspAuth, this.now(), camera.id
    );
    return Number(result.changes) > 0;
  }

  async moveToSlot(id: string, targetSlot: CameraSlot): Promise<boolean> {
    const database = this.state.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const moving = database.prepare(`SELECT ${SELECT_COLUMNS}, created_at, updated_at FROM cameras WHERE id = ?`).get(id) as unknown as CameraRow | undefined;
      if (!moving) {
        database.exec("ROLLBACK");
        return false;
      }
      const currentSlot = Number(moving.slot) as CameraSlot;
      if (currentSlot === targetSlot) {
        database.exec("COMMIT");
        return true;
      }

      const target = database.prepare(`SELECT ${SELECT_COLUMNS}, created_at, updated_at FROM cameras WHERE slot = ?`).get(targetSlot) as unknown as CameraRow | undefined;
      const now = this.now();
      if (target) database.prepare("DELETE FROM cameras WHERE id = ?").run(target.id);
      const moved = database.prepare("UPDATE cameras SET slot = ?, updated_at = ? WHERE id = ?").run(targetSlot, now, id);
      if (Number(moved.changes) !== 1) throw new Error("Camera slot move did not update the source camera.");

      if (target) {
        database.prepare(`
          INSERT INTO cameras(
            id, slot, alias, host, port, protocol, stream, path, transport, rtsp_client, rtsp_auth, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          target.id, currentSlot, target.alias ?? null, target.host, target.port ?? null, target.protocol, target.stream, target.path ?? null,
          target.transport, target.rtsp_client, target.rtsp_auth, target.created_at, now
        );
      }
      database.exec("COMMIT");
      return true;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = this.state.database.prepare("DELETE FROM cameras WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

}
