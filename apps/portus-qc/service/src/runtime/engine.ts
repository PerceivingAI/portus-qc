import { createQaEngine, type QaEngine } from "@portus-qc/engine";
import type { RequestGate } from "@portus-qc/vision";
import type { AppConfig } from "../../../config/schema";
import type { SecretStore } from "../secrets/store";
import { createMoondreamClassifier, createMoondreamProvider } from "./moondream";

export async function createConfiguredQaEngine(input: {
  config: AppConfig;
  secrets: SecretStore;
  fetchImpl?: typeof fetch;
  requestGate?: RequestGate;
}): Promise<QaEngine> {
  const [vision, classifier] = await Promise.all([
    createMoondreamProvider(input),
    createMoondreamClassifier(input)
  ]);
  return createQaEngine({ vision, classifier });
}
