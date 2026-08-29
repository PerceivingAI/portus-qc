import { parseInspection, type Inspection } from "../../../config/inspection";
import type { StateRepository } from "./repository";

interface InspectionRow {
  id: unknown;
  name: unknown;
  prompt: unknown;
  enabled: unknown;
  capability: unknown;
}

export interface InspectionRepository {
  list(): Promise<readonly Inspection[]>;
  get(id: string): Promise<Inspection | undefined>;
  create(inspection: Inspection): Promise<boolean>;
  replace(inspection: Inspection): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

function fromRow(row: InspectionRow): Inspection {
  return parseInspection({
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    capability: row.capability
  });
}

export class SqliteInspectionRepository implements InspectionRepository {
  readonly #state: StateRepository;
  readonly #now: () => string;

  constructor(state: StateRepository, now: () => string = () => new Date().toISOString()) {
    this.#state = state;
    this.#now = now;
  }

  async list(): Promise<readonly Inspection[]> {
    const rows = this.#state.database.prepare(`
      SELECT id, name, prompt, enabled, capability
      FROM inspections
      ORDER BY name COLLATE NOCASE, id
    `).all() as unknown as InspectionRow[];
    return rows.map(fromRow);
  }

  async get(id: string): Promise<Inspection | undefined> {
    const row = this.#state.database.prepare(`
      SELECT id, name, prompt, enabled, capability
      FROM inspections
      WHERE id = ?
    `).get(id) as unknown as InspectionRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  async create(inspection: Inspection): Promise<boolean> {
    const value = parseInspection(inspection);
    const now = this.#now();
    const result = this.#state.database.prepare(`
      INSERT INTO inspections(id, name, prompt, enabled, capability, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      value.id,
      value.name,
      value.prompt,
      value.enabled ? 1 : 0,
      value.capability,
      now,
      now
    );
    return Number(result.changes) > 0;
  }

  async replace(inspection: Inspection): Promise<boolean> {
    const value = parseInspection(inspection);
    const result = this.#state.database.prepare(`
      UPDATE inspections SET
        name = ?, prompt = ?, enabled = ?, capability = ?, updated_at = ?
      WHERE id = ?
    `).run(
      value.name,
      value.prompt,
      value.enabled ? 1 : 0,
      value.capability,
      this.#now(),
      value.id
    );
    return Number(result.changes) > 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.#state.database.prepare("DELETE FROM inspections WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }
}
