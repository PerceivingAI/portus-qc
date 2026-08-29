import {
  MoondreamVisionProvider,
  MoondreamVisualClassifier,
  type RequestGate
} from "@portus-qc/vision";
import type { AppConfig } from "../../../config/schema";
import { secretKeys, type SecretStore } from "../secrets/store";

export class RuntimeNotConfiguredError extends Error {
  constructor(readonly component: "moondream", message: string) {
    super(message);
    this.name = "RuntimeNotConfiguredError";
  }
}

export async function isMoondreamConfigured(secrets: SecretStore): Promise<boolean> {
  return secrets.has(secretKeys.moondreamApiKey);
}

async function apiKey(secrets: SecretStore): Promise<string> {
  const value = await secrets.get(secretKeys.moondreamApiKey);
  if (!value) throw new RuntimeNotConfiguredError("moondream", "Moondream API key is not configured.");
  return value;
}

export async function createMoondreamProvider(input: {
  config: AppConfig;
  secrets: SecretStore;
  fetchImpl?: typeof fetch;
  requestGate?: RequestGate;
}): Promise<MoondreamVisionProvider> {
  return new MoondreamVisionProvider({
    apiKey: await apiKey(input.secrets),
    model: input.config.inference.model,
    timeoutMs: input.config.inference.timeoutMs,
    maxAttempts: input.config.inference.maxAttempts,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.requestGate ? { requestGate: input.requestGate } : {})
  });
}

export async function createMoondreamClassifier(input: {
  config: AppConfig;
  secrets: SecretStore;
  fetchImpl?: typeof fetch;
  requestGate?: RequestGate;
}): Promise<MoondreamVisualClassifier> {
  return new MoondreamVisualClassifier({
    apiKey: await apiKey(input.secrets),
    model: input.config.inference.model,
    timeoutMs: input.config.inference.timeoutMs,
    maxAttempts: input.config.inference.maxAttempts,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.requestGate ? { requestGate: input.requestGate } : {})
  });
}
