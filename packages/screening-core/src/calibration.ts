import type {
  CalibrationCheckResult,
  CalibrationClassifierLabel,
  CalibrationContext,
  CalibrationEvaluator,
  CalibrationPlan,
  CalibrationResult,
  Evidence,
  InferenceImage,
  ProviderCallAudit,
  VisualClassifier
} from "@portus-qc/contracts";

const labels = Object.freeze(["ok", "warning", "fix-required"] as const);

const universalImageQualityCalibrationDefinition: CalibrationPlan = {
  id: "universal-image-quality",
  version: 2,
  steps: [
    {
      id: "check-lighting",
      checkId: "lighting",
      prompt: "Judge only lighting and exposure for general visual analysis. ok means lighting/exposure are clearly usable. warning means there is a minor lighting/exposure issue but the useful scene remains generally analyzable. fix-required means the image is materially too dark, blown out, or severely uneven enough to compromise visual analysis."
    },
    {
      id: "check-obstruction",
      checkId: "obstruction",
      prompt: "Judge only general scene obstruction or occlusion. ok means useful scene content is not materially blocked. warning means a minor obstruction exists but useful scene content remains generally analyzable. fix-required means obstruction materially blocks the useful scene and compromises visual analysis. Do not judge product-specific visibility."
    },
    {
      id: "check-focus",
      checkId: "focus",
      prompt: "Judge only image focus and blur. ok means focus is clearly adequate for general visual analysis. warning means minor blur exists but useful scene content remains generally analyzable. fix-required means blur or focus loss materially compromises visual analysis."
    },
    {
      id: "check-glare",
      checkId: "glare",
      prompt: "Judge only glare and reflection. ok means glare/reflection does not materially obscure useful content. warning means minor glare exists but useful content remains generally analyzable. fix-required means glare/reflection materially obscures useful content and compromises visual analysis."
    },
    {
      id: "check-framing",
      checkId: "framing",
      prompt: "Judge only severe general framing or cropping. ok means the captured view contains a generally usable scene. warning means framing is imperfect but useful scene content remains generally analyzable. fix-required means severe framing/cropping leaves almost no useful scene visible. Do not apply product-specific framing or scale rules."
    }
  ]
};

export const universalImageQualityCalibrationPlan: CalibrationPlan = Object.freeze(universalImageQualityCalibrationDefinition);

const deterministicMessages: Readonly<Record<string, Readonly<Record<CalibrationCheckResult["state"], string>>>> = Object.freeze({
  lighting: Object.freeze({
    ok: "Lighting and exposure are usable.",
    warning: "Lighting or exposure may reduce visual reliability.",
    "fix-required": "Adjust lighting or exposure before inspection.",
    unknown: "Lighting could not be classified reliably. Capture another image and retry."
  }),
  obstruction: Object.freeze({
    ok: "The useful scene is not materially obstructed.",
    warning: "A minor obstruction may reduce visual reliability.",
    "fix-required": "Remove or reposition the obstruction before inspection.",
    unknown: "Obstruction could not be classified reliably. Capture another image and retry."
  }),
  focus: Object.freeze({
    ok: "Image focus is usable.",
    warning: "Minor blur may reduce visual reliability.",
    "fix-required": "Improve camera focus or stability before inspection.",
    unknown: "Focus could not be classified reliably. Capture another image and retry."
  }),
  glare: Object.freeze({
    ok: "Glare and reflections are acceptable.",
    warning: "Minor glare or reflection may reduce visual reliability.",
    "fix-required": "Reduce glare or reflections before inspection.",
    unknown: "Glare could not be classified reliably. Capture another image and retry."
  }),
  framing: Object.freeze({
    ok: "Image framing is generally usable.",
    warning: "Framing is imperfect but generally usable.",
    "fix-required": "Reposition the camera to restore a generally usable view.",
    unknown: "Framing could not be classified reliably. Capture another image and retry."
  })
});

function message(checkId: string, state: CalibrationCheckResult["state"]): string {
  return deterministicMessages[checkId]?.[state]
    ?? (state === "unknown" ? "Image quality could not be classified reliably. Capture another image and retry." : `Calibration check ${checkId} classified as ${state}.`);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  if (error instanceof Error) return error.name || "error";
  return "unknown_error";
}

function evidenceState(evidence: Evidence | undefined): CalibrationCheckResult["state"] {
  if (!evidence || typeof evidence.value !== "string") return "unknown";
  return labels.includes(evidence.value as CalibrationClassifierLabel) ? evidence.value as CalibrationClassifierLabel : "unknown";
}

export const universalImageQualityCalibrationEvaluator: CalibrationEvaluator = {
  evaluate({ plan, evidence, providerCalls, context }): CalibrationResult {
    const checks = plan.steps.map((step) => {
      const matching = evidence.find((item) => item.metadataField === `calibration:${step.checkId}`);
      const state = evidenceState(matching);
      return {
        id: step.checkId,
        state,
        message: message(step.checkId, state),
        evidenceIds: matching ? [matching.id] : []
      };
    });
    const assessment = checks.some((check) => check.state === "fix-required")
      ? "needs-adjustment"
      : checks.some((check) => check.state === "unknown")
        ? "unknown"
        : "suitable";

    return {
      runId: context.run.id,
      planId: plan.id,
      planVersion: plan.version,
      assessment,
      checks,
      evidence,
      providerCalls,
      createdAt: context.createdAt
    };
  }
};

export class CalibrationEngine {
  async run(plan: CalibrationPlan, image: InferenceImage, classifier: VisualClassifier, evaluator: CalibrationEvaluator, context: CalibrationContext): Promise<CalibrationResult> {
    if (context.run.planId !== plan.id || context.run.planVersion !== plan.version) throw new Error("Calibration run plan version does not match calibration plan.");

    const evidence: Evidence[] = [];
    const providerCalls: ProviderCallAudit[] = [];

    for (const step of plan.steps) {
      try {
        const response = await classifier.classify({ image, question: step.prompt, labels });
        if (!labels.includes(response.label)) throw Object.assign(new Error("Visual classifier returned a label outside the allowed calibration vocabulary."), { code: "invalid_label" });
        providerCalls.push({
          capability: "classify",
          provider: response.provider,
          model: response.model,
          status: "success",
          ...(response.requestId ? { requestId: response.requestId } : {}),
          ...(response.durationMs !== undefined ? { durationMs: response.durationMs } : {}),
          ...(response.usage ? { usage: response.usage } : {})
        });
        evidence.push({
          id: `${context.run.id}:${step.checkId}`,
          kind: "structured",
          metadataField: `calibration:${step.checkId}`,
          value: response.label,
          frameId: image.id,
          provider: response.provider,
          model: response.model,
          ...(response.requestId ? { requestId: response.requestId } : {})
        });
      } catch (error) {
        providerCalls.push({ capability: "classify", provider: classifier.id, model: classifier.model, status: "failed", errorCode: errorCode(error) });
        // Classification failures are represented locally as unknown so remaining checks still run.
      }
    }

    return evaluator.evaluate({ plan, image, evidence, providerCalls, context });
  }
}
