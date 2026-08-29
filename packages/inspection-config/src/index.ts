import type {
  InferenceImage,
  VisionCapability,
  VisionProvider,
  VisionResponse
} from "@portus-qc/contracts";

export type InspectionCapability = VisionCapability;

export interface InspectionDefinition {
  id: string;
  name: string;
  prompt: string;
  description?: string;
  capability: InspectionCapability;
}

export type CompiledInspectionDefinition = Readonly<InspectionDefinition>;

export class InspectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectionConfigError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const CAPABILITIES = new Set<InspectionCapability>(["query", "caption", "detect", "point", "segment"]);

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new InspectionConfigError(`${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new InspectionConfigError(`${name} must not be empty.`);
  if (normalized.length > maxLength) throw new InspectionConfigError(`${name} must be at most ${maxLength} characters.`);
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new InspectionConfigError(`${name} contains unsupported field(s): ${extra.join(", ")}.`);
}

function capability(value: unknown): InspectionCapability {
  if (typeof value !== "string" || !CAPABILITIES.has(value as InspectionCapability)) {
    throw new InspectionConfigError("Inspection capability must be query, detect, segment, point, or caption.");
  }
  return value as InspectionCapability;
}

export function validateInspectionDefinition(input: unknown): InspectionDefinition {
  const record = asRecord(input);
  if (!record) throw new InspectionConfigError("Inspection definition must be an object.");
  exactKeys(record, ["id", "name", "prompt", "description", "capability"], "Inspection definition");

  const id = requiredText(record.id, "Inspection id", 80);
  if (!ID_PATTERN.test(id)) throw new InspectionConfigError("Inspection id may contain only letters, numbers, dot, underscore, and hyphen and must start with a letter or number.");
  const name = requiredText(record.name, "Inspection name", 120);
  const prompt = requiredText(record.prompt, "Inspection prompt", 4000);
  let description: string | undefined;
  if (record.description !== undefined) {
    if (typeof record.description !== "string") throw new InspectionConfigError("Inspection description must be a string.");
    description = record.description.trim();
    if (description.length > 500) throw new InspectionConfigError("Inspection description must be at most 500 characters.");
  }

  return {
    id,
    name,
    prompt,
    ...(description ? { description } : {}),
    capability: capability(record.capability)
  };
}

export function compileInspectionDefinition(input: unknown): CompiledInspectionDefinition {
  return Object.freeze(validateInspectionDefinition(input));
}

export async function executeInspectionDefinition(
  input: unknown,
  image: InferenceImage,
  provider: VisionProvider
): Promise<VisionResponse> {
  const definition = compileInspectionDefinition(input);
  if (!provider.supports(definition.capability)) {
    throw new InspectionConfigError(`Vision provider ${provider.id} does not support inspection capability ${definition.capability}.`);
  }

  const response = await provider.execute({
    capability: definition.capability,
    image,
    prompt: definition.prompt
  });

  if (response.capability !== definition.capability || response.result.capability !== definition.capability) {
    throw new InspectionConfigError(`Vision provider ${provider.id} returned ${response.result.capability} for inspection capability ${definition.capability}.`);
  }
  return response;
}
