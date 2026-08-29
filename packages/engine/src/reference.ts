import type {
  CalibrationClassifierLabel,
  Evidence,
  ScreeningProfile,
  ScreeningResult,
  VisionCapability,
  VisionProvider,
  VisionRequest,
  VisionResponse,
  VisualClassificationRequest,
  VisualClassificationResponse,
  VisualClassifier
} from "@portus-qc/contracts";
import type { ProfileEvaluator } from "@portus-qc/screening-core";
import type { ScreeningPlugin } from "./index";

const referenceDefinition: ScreeningProfile = {
  id: "reference-subject-visibility",
  version: 1,
  screeningPlan: [
    {
      id: "subject-visible",
      capability: "query",
      prompt: "Is the primary inspection subject clearly visible enough for visual inspection? Answer only yes or no.",
      findingId: "subject-visible",
      required: true
    }
  ]
};

export const referenceVisibilityProfile: ScreeningProfile = Object.freeze(referenceDefinition);

function visibilityAnswer(evidence: readonly Evidence[]): "yes" | "no" | "unknown" {
  const item = evidence.find((candidate) => candidate.findingId === "subject-visible" && candidate.kind === "text");
  if (!item || typeof item.value !== "string") return "unknown";
  const answer = item.value.trim().toLowerCase().replace(/[.!]+$/gu, "");
  if (answer === "yes") return "yes";
  if (answer === "no") return "no";
  return "unknown";
}

export const referenceVisibilityEvaluator: ProfileEvaluator = {
  evaluate({ profile, evidence, providerCalls, context }): ScreeningResult {
    const answer = visibilityAnswer(evidence);
    return {
      id: context.resultId,
      profileId: profile.id,
      profileVersion: profile.version,
      decision: answer === "yes" ? "PASS" : "REVIEW",
      evidence,
      metrics: {
        subject_visible: answer === "yes",
        visibility_answer_known: answer !== "unknown"
      },
      metadata: {},
      providerCalls,
      createdAt: context.createdAt
    };
  }
};

export const referenceVisibilityPlugin: ScreeningPlugin = Object.freeze({
  profile: referenceVisibilityProfile,
  evaluator: referenceVisibilityEvaluator
});

export interface DeterministicVisionProviderOptions {
  answer?: "yes" | "no";
  model?: string;
}

/** Zero-network provider fixture for public examples, tests, and CI. */
export class DeterministicVisionProvider implements VisionProvider {
  readonly id = "deterministic-reference";
  readonly model: string;
  readonly #answer: "yes" | "no";

  constructor(options: DeterministicVisionProviderOptions = {}) {
    this.#answer = options.answer ?? "yes";
    this.model = options.model?.trim() || "fixture-v1";
  }

  supports(capability: VisionCapability): boolean {
    return capability === "query";
  }

  async execute(request: VisionRequest): Promise<VisionResponse> {
    if (!this.supports(request.capability)) throw new Error(`Deterministic reference provider does not support ${request.capability}.`);
    return {
      capability: "query",
      result: { capability: "query", text: this.#answer },
      provider: this.id,
      model: this.model,
      requestId: "fixture-query",
      durationMs: 0
    };
  }
}

export interface DeterministicVisualClassifierOptions {
  label?: CalibrationClassifierLabel;
  model?: string;
}

/** Zero-network visual classifier fixture for calibration examples, tests, and CI. */
export class DeterministicVisualClassifier implements VisualClassifier {
  readonly id = "deterministic-reference";
  readonly model: string;
  readonly #label: CalibrationClassifierLabel;

  constructor(options: DeterministicVisualClassifierOptions = {}) {
    this.#label = options.label ?? "ok";
    this.model = options.model?.trim() || "fixture-v1";
  }

  async classify(request: VisualClassificationRequest): Promise<VisualClassificationResponse> {
    if (!request.labels.includes(this.#label)) throw new Error(`Deterministic classifier label ${this.#label} is not allowed by this request.`);
    return {
      label: this.#label,
      provider: this.id,
      model: this.model,
      requestId: "fixture-classify",
      durationMs: 0
    };
  }
}
