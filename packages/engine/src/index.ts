import type {
  CalibrationEvaluator,
  CalibrationPlan,
  CalibrationResult,
  InferenceImage,
  ScreeningProfile,
  ScreeningResult,
  VisionProvider,
  VisualClassifier
} from "@portus-qc/contracts";
import {
  CalibrationEngine,
  ScreeningPipeline,
  universalImageQualityCalibrationEvaluator,
  universalImageQualityCalibrationPlan,
  type ProfileEvaluator
} from "@portus-qc/screening-core";

export { MediaPreflightError, prepareInferenceImage, preflightImage } from "@portus-qc/media";
export type { ImageIntake, MediaPreflightPolicy } from "@portus-qc/media";
export type {
  CalibrationAssessment,
  CalibrationCheckResult,
  CalibrationPlan,
  CalibrationResult,
  Evidence,
  InferenceImage,
  ProviderCallAudit,
  ScreeningDecision,
  ScreeningProfile,
  ScreeningResult,
  SourceMetadata,
  VisionCapability,
  VisualClassifier,
  VisionProvider
} from "@portus-qc/contracts";
export type { ProfileEvaluator } from "@portus-qc/screening-core";
export { universalImageQualityCalibrationPlan } from "@portus-qc/screening-core";

export interface ScreeningPlugin {
  profile: ScreeningProfile;
  evaluator: ProfileEvaluator;
}

export type EngineIdKind = "screening-result" | "calibration-run";

export interface QaEngineOptions {
  vision: VisionProvider;
  classifier?: VisualClassifier;
  now?: () => string;
  idFactory?: (kind: EngineIdKind) => string;
}

export interface ScreenInput {
  plugin: ScreeningPlugin;
  image: InferenceImage;
  resultId?: string;
  createdAt?: string;
}

export interface CalibrateInput {
  image: InferenceImage;
  runId?: string;
  createdAt?: string;
  plan?: CalibrationPlan;
  evaluator?: CalibrationEvaluator;
}

function defaultIdFactory(kind: EngineIdKind): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== "function") throw new Error("This runtime does not provide crypto.randomUUID(); configure QaEngine with idFactory.");
  return `${kind}_${randomUUID.call(globalThis.crypto)}`;
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty.`);
  return normalized;
}

/** Stable product-neutral facade over the screening and calibration implementation. */
export class QaEngine {
  readonly #vision: VisionProvider;
  readonly #classifier: VisualClassifier | undefined;
  readonly #now: () => string;
  readonly #idFactory: (kind: EngineIdKind) => string;

  constructor(options: QaEngineOptions) {
    this.#vision = options.vision;
    this.#classifier = options.classifier;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? defaultIdFactory;
  }

  async screen(input: ScreenInput): Promise<ScreeningResult> {
    const createdAt = requireNonEmpty(input.createdAt ?? this.#now(), "createdAt");
    const resultId = requireNonEmpty(input.resultId ?? this.#idFactory("screening-result"), "resultId");
    return new ScreeningPipeline(this.#vision, input.plugin.evaluator).run(input.plugin.profile, input.image, { resultId, createdAt });
  }

  async calibrate(input: CalibrateInput): Promise<CalibrationResult> {
    const plan = input.plan ?? universalImageQualityCalibrationPlan;
    const evaluator = input.evaluator ?? universalImageQualityCalibrationEvaluator;
    const createdAt = requireNonEmpty(input.createdAt ?? this.#now(), "createdAt");
    const runId = requireNonEmpty(input.runId ?? this.#idFactory("calibration-run"), "runId");
    if (!this.#classifier) throw new Error("Calibration requires a VisualClassifier; configure QaEngine with classifier.");
    return new CalibrationEngine().run(plan, input.image, this.#classifier, evaluator, {
      run: {
        id: runId,
        planId: plan.id,
        planVersion: plan.version,
        source: input.image.source,
        createdAt
      },
      createdAt
    });
  }
}

export function createQaEngine(options: QaEngineOptions): QaEngine {
  return new QaEngine(options);
}
