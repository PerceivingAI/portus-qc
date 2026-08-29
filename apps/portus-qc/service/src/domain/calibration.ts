import { randomUUID } from "node:crypto";
import type {
  CalibrationCheckState,
  CalibrationResult,
  Evidence,
  InferenceImage,
  ProviderCallAudit
} from "@portus-qc/contracts";
import type { ApplicationRuntime } from "../runtime";
import { RuntimeNotConfiguredError } from "../runtime/moondream";

export type CalibrationDomainErrorCode = "moondream_not_configured" | "operation_failed";

export class CalibrationDomainError extends Error {
  constructor(readonly code: CalibrationDomainErrorCode, message: string) {
    super(message);
    this.name = "CalibrationDomainError";
  }
}

export interface CalibrationService {
  calibrate(image: InferenceImage): Promise<CalibrationResult>;
}

const CHECKS = ["lighting", "obstruction", "focus", "glare", "framing"] as const;
type CheckId = typeof CHECKS[number];

const CALIBRATION_PROMPT = `Evaluate this input image only for suitability as input to Moondream visual inference. This is an informational input calibration report, not a product inspection and not a pass/fail decision.

Return ONLY valid JSON with exactly these top-level fields: lighting, obstruction, focus, glare, framing.
Each field must be an object with:
- "state": exactly one of "ok", "warning", "fix-required"
- "note": one short factual, actionable sentence for the operator

Use these meanings:
- lighting: exposure and useful illumination; flag images that are too dark, blown out, or severely uneven
- obstruction: anything physically blocking or materially occluding the useful scene
- focus: blur, defocus, or motion/stability problems that reduce visible detail
- glare: reflections or glare that materially hide useful visual information
- framing: severe cropping, composition, or scene coverage problems that make the visible input generally unsuitable

Do not judge product quality, defects, compliance, or task-specific acceptance criteria. Do not infer what the user intends to inspect. The purpose is only to help the operator improve lighting, focus, framing, scene visibility, and other general input conditions for Moondream.`;

const deterministicMessages: Readonly<Record<CheckId, Readonly<Record<Exclude<CalibrationCheckState, "unknown">, string>>>> = Object.freeze({
  lighting: Object.freeze({
    ok: "Lighting and exposure are usable.",
    warning: "Lighting or exposure may reduce visual reliability.",
    "fix-required": "Adjust lighting or exposure before inspection."
  }),
  obstruction: Object.freeze({
    ok: "The useful scene is not materially obstructed.",
    warning: "A minor obstruction may reduce visual reliability.",
    "fix-required": "Remove or reposition the obstruction before inspection."
  }),
  focus: Object.freeze({
    ok: "Image focus is usable.",
    warning: "Minor blur may reduce visual reliability.",
    "fix-required": "Improve camera focus or stability before inspection."
  }),
  glare: Object.freeze({
    ok: "Glare and reflections are acceptable.",
    warning: "Minor glare or reflection may reduce visual reliability.",
    "fix-required": "Reduce glare or reflections before inspection."
  }),
  framing: Object.freeze({
    ok: "Image framing is generally usable.",
    warning: "Framing is imperfect but generally usable.",
    "fix-required": "Reposition the camera to restore a generally usable view."
  })
});

const fallbackMessages: Readonly<Record<CheckId, string>> = Object.freeze({
  lighting: "Lighting could not be evaluated from the calibration response.",
  obstruction: "Scene obstruction could not be evaluated from the calibration response.",
  focus: "Focus could not be evaluated from the calibration response.",
  glare: "Glare could not be evaluated from the calibration response.",
  framing: "Framing could not be evaluated from the calibration response."
});

function normalizeError(error: unknown): never {
  if (error instanceof CalibrationDomainError) throw error;
  if (error instanceof RuntimeNotConfiguredError && error.component === "moondream") {
    throw new CalibrationDomainError("moondream_not_configured", "Moondream is not configured.");
  }
  throw new CalibrationDomainError("operation_failed", "Calibration could not be completed.");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Calibration response did not contain a JSON object.");
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  const object = record(parsed);
  if (!object) throw new Error("Calibration response JSON must be an object.");
  return object;
}

function validState(value: unknown): value is Exclude<CalibrationCheckState, "unknown"> {
  return value === "ok" || value === "warning" || value === "fix-required";
}

function checkValue(payload: Record<string, unknown>, id: CheckId): { state: CalibrationCheckState; message: string } {
  const raw = payload[id];
  if (validState(raw)) return { state: raw, message: deterministicMessages[id][raw] };

  const value = record(raw);
  const state = value?.state;
  if (!validState(state)) return { state: "unknown", message: fallbackMessages[id] };

  const note = typeof value?.note === "string" ? value.note.trim() : "";
  return { state, message: note && note.length <= 500 ? note : deterministicMessages[id][state] };
}

function assessment(states: readonly CalibrationCheckState[]): CalibrationResult["assessment"] {
  if (states.some((state) => state === "fix-required")) return "needs-adjustment";
  if (states.some((state) => state === "unknown")) return "unknown";
  return "suitable";
}

export interface RawCalibrationResponseObservation {
  provider: string;
  model: string;
  requestId?: string;
  text: string;
}

export function createCalibrationService(input: {
  runtime: ApplicationRuntime;
  now?: () => string;
  idFactory?: () => string;
  onRawResponse?: (observation: RawCalibrationResponseObservation) => void;
}): CalibrationService {
  const now = input.now ?? (() => new Date().toISOString());
  const idFactory = input.idFactory ?? (() => `calibration-run_${randomUUID()}`);

  return {
    async calibrate(image: InferenceImage): Promise<CalibrationResult> {
      try {
        const provider = await input.runtime.createMoondream();
        const response = await provider.execute({ image, capability: "query", prompt: CALIBRATION_PROMPT });
        if (response.result.capability !== "query") throw new Error("Calibration query returned the wrong capability.");
        try {
          input.onRawResponse?.({
            provider: response.provider,
            model: response.model,
            ...(response.requestId ? { requestId: response.requestId } : {}),
            text: response.result.text
          });
        } catch {
          // Diagnostic observation must never affect calibration behavior.
        }
        const parsed = jsonObject(response.result.text);
        const runId = idFactory();
        const createdAt = now();
        const checks = CHECKS.map((id) => {
          const normalized = checkValue(parsed, id);
          return { id, state: normalized.state, message: normalized.message, evidenceIds: [`${runId}:${id}`] };
        });
        const evidence: Evidence[] = checks.map((check) => ({
          id: check.evidenceIds[0]!,
          kind: "structured",
          metadataField: `calibration:${check.id}`,
          value: { state: check.state, message: check.message },
          frameId: image.id,
          provider: response.provider,
          model: response.model,
          ...(response.requestId ? { requestId: response.requestId } : {})
        }));
        const providerCalls: ProviderCallAudit[] = [{
          capability: "query",
          provider: response.provider,
          model: response.model,
          status: "success",
          ...(response.requestId ? { requestId: response.requestId } : {}),
          ...(response.durationMs !== undefined ? { durationMs: response.durationMs } : {}),
          ...(response.usage ? { usage: response.usage } : {})
        }];
        return {
          runId,
          planId: "input-moondream-readiness",
          planVersion: 2,
          assessment: assessment(checks.map((check) => check.state)),
          checks,
          evidence,
          providerCalls,
          createdAt
        };
      } catch (error) {
        return normalizeError(error);
      }
    }
  };
}
