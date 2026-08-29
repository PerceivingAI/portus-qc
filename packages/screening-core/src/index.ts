import type {
  BoxGeometry,
  Evidence,
  InferenceImage,
  ProfileVisionStep,
  ProviderCallAudit,
  ScreeningProfile,
  ScreeningResult,
  VisionProvider,
  VisionRequest,
  VisionResponse
} from "@portus-qc/contracts";

export interface ScreeningContext {
  resultId: string;
  createdAt: string;
}

export interface ProfileEvaluator {
  evaluate(input: {
    profile: ScreeningProfile;
    image: InferenceImage;
    evidence: readonly Evidence[];
    providerCalls: readonly ProviderCallAudit[];
    context: ScreeningContext;
  }): ScreeningResult;
}

function baseEvidence(step: ProfileVisionStep, response: VisionResponse, frameId: string, suffix: string) {
  return {
    id: `${step.id}:${response.requestId ?? "local"}:${suffix}`,
    frameId,
    provider: response.provider,
    model: response.model,
    ...(response.requestId ? { requestId: response.requestId } : {}),
    ...(step.findingId ? { findingId: step.findingId } : {}),
    ...(step.metadataField ? { metadataField: step.metadataField } : {})
  };
}

export function normalizeVisionEvidence(step: ProfileVisionStep, response: VisionResponse, frameId: string): readonly Evidence[] {
  if (response.capability !== step.capability || response.result.capability !== step.capability) {
    throw new Error(`Vision provider returned ${response.result.capability} for requested capability ${step.capability}.`);
  }

  const result = response.result;
  if (result.capability === "detect") {
    return result.boxes.map((box, index) => ({
      ...baseEvidence(step, response, frameId, String(index)),
      kind: "box" as const,
      value: box
    }));
  }

  if (result.capability === "point") {
    return result.points.map((point, index) => ({
      ...baseEvidence(step, response, frameId, String(index)),
      kind: "point" as const,
      value: point
    }));
  }

  if (result.capability === "segment") {
    return result.regions.map((region, index) => ({
      ...baseEvidence(step, response, frameId, String(index)),
      kind: "mask" as const,
      value: region
    }));
  }

  return [{
    ...baseEvidence(step, response, frameId, "0"),
    kind: "text" as const,
    value: result.text
  }];
}

function stableEvidenceKey(item: Evidence): string {
  return JSON.stringify([item.frameId, item.kind, item.findingId ?? null, item.metadataField ?? null, item.value]);
}

export function mergeEvidence(items: readonly Evidence[]): readonly Evidence[] {
  const unique = new Map<string, Evidence>();
  for (const item of items) {
    const key = stableEvidenceKey(item);
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

export function associateEvidence(items: readonly Evidence[]): readonly Evidence[] {
  return items.map((item) => {
    const related = items
      .filter((candidate) => candidate.id !== item.id && candidate.frameId === item.frameId && candidate.findingId && candidate.findingId === item.findingId)
      .map((candidate) => ({ type: "same-finding" as const, evidenceId: candidate.id }));
    return related.length > 0 ? { ...item, associations: related } : item;
  });
}

export function boxAreaRatio(box: BoxGeometry): number {
  return Math.max(0, box.xMax - box.xMin) * Math.max(0, box.yMax - box.yMin);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  if (error instanceof Error) return error.name || "error";
  return "unknown_error";
}

export class ScreeningPipeline {
  constructor(private readonly vision: VisionProvider, private readonly evaluator: ProfileEvaluator) {}

  async run(profile: ScreeningProfile, image: InferenceImage, context: ScreeningContext): Promise<ScreeningResult> {
    const evidence: Evidence[] = [];
    const providerCalls: ProviderCallAudit[] = [];

    for (const step of profile.screeningPlan) {
      if (!this.vision.supports(step.capability)) {
        if (step.required) throw new Error(`Vision provider ${this.vision.id} does not support required capability ${step.capability}.`);
        continue;
      }
      const request: VisionRequest = {
        capability: step.capability,
        image,
        prompt: step.prompt,
        ...(step.findingId ? { findingId: step.findingId } : {}),
        ...(step.metadataField ? { metadataField: step.metadataField } : {})
      };

      try {
        const response = await this.vision.execute(request);
        providerCalls.push({
          capability: response.capability,
          provider: response.provider,
          model: response.model,
          status: "success",
          ...(response.requestId ? { requestId: response.requestId } : {}),
          ...(response.durationMs !== undefined ? { durationMs: response.durationMs } : {}),
          ...(response.usage ? { usage: response.usage } : {})
        });
        evidence.push(...normalizeVisionEvidence(step, response, image.id));
      } catch (error) {
        providerCalls.push({
          capability: step.capability,
          provider: this.vision.id,
          model: this.vision.model,
          status: "failed",
          errorCode: errorCode(error)
        });
        if (step.required) throw error;
      }
    }

    return this.evaluator.evaluate({
      profile,
      image,
      evidence: associateEvidence(mergeEvidence(evidence)),
      providerCalls,
      context
    });
  }
}

export * from "./calibration";
