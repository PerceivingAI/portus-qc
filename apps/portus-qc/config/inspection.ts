import {
  validateInspectionDefinition,
  type InspectionCapability,
  type InspectionDefinition
} from "@portus-qc/inspection-config";

export interface Inspection {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  capability: InspectionCapability;
}

export interface CreateInspectionInput {
  id: string;
  name: string;
  prompt: string;
  enabled?: boolean;
  capability?: InspectionCapability;
}

export interface ReplaceInspectionInput {
  name: string;
  prompt: string;
  enabled: boolean;
  capability: InspectionCapability;
}

export class AppInspectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppInspectionConfigError";
  }
}

export const defaultInspectionCapability: InspectionCapability = "query";

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AppInspectionConfigError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new AppInspectionConfigError(`${name} contains unsupported field(s): ${extras.join(", ")}.`);
}

function validateCore(id: unknown, name: unknown, prompt: unknown, capability: unknown): Omit<Inspection, "enabled"> {
  try {
    const definition = validateInspectionDefinition({ id, name, prompt, capability });
    return { id: definition.id, name: definition.name, prompt: definition.prompt, capability: definition.capability };
  } catch (error) {
    throw new AppInspectionConfigError(error instanceof Error ? error.message : "Inspection configuration is invalid.");
  }
}

export function parseInspection(input: unknown): Inspection {
  const value = record(input, "Inspection");
  exactKeys(value, ["id", "name", "prompt", "enabled", "capability"], "Inspection");
  if (typeof value.enabled !== "boolean") throw new AppInspectionConfigError("Inspection enabled must be a boolean.");
  return {
    ...validateCore(value.id, value.name, value.prompt, value.capability),
    enabled: value.enabled
  };
}

export function parseCreateInspectionInput(input: unknown): Inspection {
  const value = record(input, "Inspection create input");
  exactKeys(value, ["id", "name", "prompt", "enabled", "capability"], "Inspection create input");
  return parseInspection({
    id: value.id,
    name: value.name,
    prompt: value.prompt,
    enabled: value.enabled ?? true,
    capability: value.capability ?? defaultInspectionCapability
  });
}

export function parseReplaceInspectionInput(id: string, input: unknown): Inspection {
  const value = record(input, "Inspection replace input");
  exactKeys(value, ["name", "prompt", "enabled", "capability"], "Inspection replace input");
  return parseInspection({ id, ...value });
}

export function toInspectionDefinition(inspection: Inspection): InspectionDefinition {
  const normalized = parseInspection(inspection);
  return validateInspectionDefinition({
    id: normalized.id,
    name: normalized.name,
    prompt: normalized.prompt,
    capability: normalized.capability
  });
}
