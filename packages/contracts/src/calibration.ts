import type { Evidence, Id, InferenceImage, IsoTimestamp, ProviderCallAudit, SourceMetadata } from "./index";

export type CalibrationClassifierLabel = "ok" | "warning" | "fix-required";
export type CalibrationCheckState = CalibrationClassifierLabel | "unknown";
export type CalibrationAssessment = "suitable" | "needs-adjustment" | "unknown";

export interface VisualClassificationRequest {
  image: InferenceImage;
  question: string;
  labels: readonly CalibrationClassifierLabel[];
}

export interface VisualClassificationResponse {
  label: CalibrationClassifierLabel;
  provider: string;
  model: string;
  requestId?: string;
  durationMs?: number;
  usage?: Readonly<Record<string, number>>;
}

/** Separate from VisionProvider: classification must not change native Query semantics. */
export interface VisualClassifier {
  readonly id: string;
  readonly model: string;
  classify(request: VisualClassificationRequest): Promise<VisualClassificationResponse>;
}

export interface CalibrationPlanStep {
  id: string;
  checkId: string;
  prompt: string;
}

/** Global, product-agnostic image-quality assessment contract. */
export interface CalibrationPlan {
  id: string;
  version: number;
  steps: readonly CalibrationPlanStep[];
}

export interface CalibrationRun {
  id: Id;
  planId: string;
  planVersion: number;
  source: SourceMetadata;
  createdAt: IsoTimestamp;
}

export interface CalibrationCheckResult {
  id: string;
  state: CalibrationCheckState;
  message: string;
  evidenceIds: readonly Id[];
}

export interface CalibrationResult {
  runId: Id;
  planId: string;
  planVersion: number;
  assessment: CalibrationAssessment;
  checks: readonly CalibrationCheckResult[];
  evidence: readonly Evidence[];
  providerCalls: readonly ProviderCallAudit[];
  createdAt: IsoTimestamp;
}

export interface CalibrationContext {
  run: CalibrationRun;
  createdAt: IsoTimestamp;
}

export interface CalibrationEvaluationInput {
  plan: CalibrationPlan;
  image: InferenceImage;
  evidence: readonly Evidence[];
  providerCalls: readonly ProviderCallAudit[];
  context: CalibrationContext;
}

export interface CalibrationEvaluator {
  evaluate(input: CalibrationEvaluationInput): CalibrationResult;
}

export interface CalibrationExecutor {
  run(plan: CalibrationPlan, image: InferenceImage, classifier: VisualClassifier, evaluator: CalibrationEvaluator, context: CalibrationContext): Promise<CalibrationResult>;
}
