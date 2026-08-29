import type { CamsnapCredentials, CamsnapRuntime } from "@portus-qc/camsnap";
import type { QaEngine } from "@portus-qc/engine";
import {
  FixedIntervalRequestGate,
  type MoondreamVisionProvider,
  type MoondreamVisualClassifier
} from "@portus-qc/vision";
import type { LocalApplicationState } from "../local-state";
import { createConfiguredQaEngine } from "./engine";
import { createMoondreamClassifier, createMoondreamProvider, isMoondreamConfigured } from "./moondream";
import { probeCamsnapExecutable, withCamsnapRuntime } from "./camsnap";
import { probeFfmpegExecutable, resolveFfmpegExecutable } from "./ffmpeg";

export interface ApplicationRuntime {
  createEngine(): Promise<QaEngine>;
  createMoondream(): Promise<MoondreamVisionProvider>;
  createMoondreamClassifier(): Promise<MoondreamVisualClassifier>;
  withCamsnap<T>(operation: (runtime: CamsnapRuntime) => Promise<T>, credentials?: CamsnapCredentials): Promise<T>;
  resolveFfmpeg(): Promise<string>;
  moondreamConfigured(): Promise<boolean>;
  probeCamsnap(): ReturnType<typeof probeCamsnapExecutable>;
  probeFfmpeg(): ReturnType<typeof probeFfmpegExecutable>;
}

export function createApplicationRuntime(state: LocalApplicationState): ApplicationRuntime {
  const requestGate = new FixedIntervalRequestGate({ requestsPerSecond: state.config.inference.maxRequestsPerSecond });
  return {
    createEngine: () => createConfiguredQaEngine({ config: state.config, secrets: state.secrets, requestGate }),
    createMoondream: () => createMoondreamProvider({ config: state.config, secrets: state.secrets, requestGate }),
    createMoondreamClassifier: () => createMoondreamClassifier({ config: state.config, secrets: state.secrets, requestGate }),
    withCamsnap: (operation, credentials) => withCamsnapRuntime({
      config: state.config,
      paths: state.paths,
      secrets: state.secrets,
      ...(credentials ? { credentials } : {})
    }, operation),
    resolveFfmpeg: () => resolveFfmpegExecutable(state.config),
    moondreamConfigured: () => isMoondreamConfigured(state.secrets),
    probeCamsnap: () => probeCamsnapExecutable(state.config),
    probeFfmpeg: () => probeFfmpegExecutable(state.config)
  };
}
