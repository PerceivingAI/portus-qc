import {
  compileInspectionDefinition,
  type CompiledInspectionDefinition
} from "@portus-qc/inspection-config";
import {
  AppInspectionConfigError,
  parseCreateInspectionInput,
  parseReplaceInspectionInput,
  toInspectionDefinition,
  type Inspection
} from "../../../config/inspection";
import type { InspectionRepository } from "../persistence/inspections";

export type InspectionDomainErrorCode = "invalid" | "not_found" | "conflict" | "disabled";

export class InspectionDomainError extends Error {
  constructor(readonly code: InspectionDomainErrorCode, message: string) {
    super(message);
    this.name = "InspectionDomainError";
  }
}

export interface InspectionService {
  list(): Promise<readonly Inspection[]>;
  get(id: string): Promise<Inspection>;
  create(input: unknown): Promise<Inspection>;
  replace(id: string, input: unknown): Promise<Inspection>;
  delete(id: string): Promise<void>;
  prepare(id: string): Promise<{ inspection: Inspection; execution: CompiledInspectionDefinition }>;
}

function normalizedId(id: string): string {
  const value = id.trim();
  if (!value) throw new InspectionDomainError("invalid", "Inspection id must not be empty.");
  return value;
}

function invalid(error: unknown): never {
  if (error instanceof InspectionDomainError) throw error;
  if (error instanceof AppInspectionConfigError) throw new InspectionDomainError("invalid", error.message);
  throw error;
}

export function createInspectionService(repository: InspectionRepository): InspectionService {
  return {
    list(): Promise<readonly Inspection[]> {
      return repository.list();
    },

    async get(id: string): Promise<Inspection> {
      const inspection = await repository.get(normalizedId(id));
      if (!inspection) throw new InspectionDomainError("not_found", `Inspection ${id} was not found.`);
      return inspection;
    },

    async create(input: unknown): Promise<Inspection> {
      let inspection: Inspection;
      try { inspection = parseCreateInspectionInput(input); }
      catch (error) { return invalid(error); }
      if (!await repository.create(inspection)) throw new InspectionDomainError("conflict", `Inspection ${inspection.id} already exists.`);
      return inspection;
    },

    async replace(id: string, input: unknown): Promise<Inspection> {
      let inspection: Inspection;
      try { inspection = parseReplaceInspectionInput(normalizedId(id), input); }
      catch (error) { return invalid(error); }
      if (!await repository.replace(inspection)) throw new InspectionDomainError("not_found", `Inspection ${inspection.id} was not found.`);
      return inspection;
    },

    async delete(id: string): Promise<void> {
      const normalized = normalizedId(id);
      if (!await repository.delete(normalized)) throw new InspectionDomainError("not_found", `Inspection ${normalized} was not found.`);
    },

    async prepare(id: string): Promise<{ inspection: Inspection; execution: CompiledInspectionDefinition }> {
      const inspection = await this.get(id);
      if (!inspection.enabled) throw new InspectionDomainError("disabled", `Inspection ${inspection.id} is disabled.`);
      return { inspection, execution: compileInspectionDefinition(toInspectionDefinition(inspection)) };
    }
  };
}
