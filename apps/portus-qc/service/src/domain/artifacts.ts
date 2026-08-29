import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { MediaStore } from "../media/store";
import type { AppSettingsRepository } from "../persistence/settings";
import type { ResultRepository, StoredInspectionResult } from "../persistence/results";
import type { FolderPicker } from "../runtime/folder-picker";
import { exportResultArtifact, type ExportedArtifact } from "../artifacts/exporter";

export type ArtifactServiceErrorCode = "invalid_root" | "result_not_found" | "source_missing" | "export_failed";

export class ArtifactServiceError extends Error {
  constructor(readonly code: ArtifactServiceErrorCode, message: string) {
    super(message);
    this.name = "ArtifactServiceError";
  }
}

export interface ArtifactSettingsView {
  root: string;
  configuredRoot: string | null;
}

export interface ArtifactService {
  settings(): ArtifactSettingsView;
  setRoot(root: string | null): Promise<ArtifactSettingsView>;
  pickRoot(): Promise<{ selected: boolean; settings: ArtifactSettingsView }>;
  exportResult(id: string): Promise<ExportedArtifact>;
}

function spatial(result: StoredInspectionResult): boolean {
  return result.capability === "detect" || result.capability === "segment" || result.capability === "point";
}

export function createArtifactService(input: {
  initialRoot: string;
  defaultRoot: string;
  initialConfiguredRoot: string | null;
  results: ResultRepository;
  media: MediaStore;
  settingsRepository: AppSettingsRepository;
  folderPicker: FolderPicker;
}): ArtifactService {
  let currentRoot = input.initialRoot;
  let configuredRoot = input.initialConfiguredRoot;

  const view = (): ArtifactSettingsView => ({ root: currentRoot, configuredRoot });

  async function persistRoot(root: string | null): Promise<ArtifactSettingsView> {
    if (root !== null && !isAbsolute(root)) throw new ArtifactServiceError("invalid_root", "Artifact root must be an absolute path.");
    const resolved = root === null ? input.defaultRoot : resolve(root);
    await mkdir(resolved, { recursive: true });
    await input.settingsRepository.update((persisted) => ({ ...(persisted ?? {}), artifacts: { root } }));
    currentRoot = resolved;
    configuredRoot = root;
    return view();
  }

  return {
    settings: view,
    setRoot: persistRoot,
    async pickRoot() {
      const selected = await input.folderPicker.pick(currentRoot);
      if (!selected) return { selected: false, settings: view() };
      return { selected: true, settings: await persistRoot(selected) };
    },
    async exportResult(id: string): Promise<ExportedArtifact> {
      const result = await input.results.get(id);
      if (!result) throw new ArtifactServiceError("result_not_found", `Result ${id} does not exist.`);
      let sourceBytes: Uint8Array | undefined;
      if (spatial(result)) {
        if (!result.sourceMediaRef) throw new ArtifactServiceError("source_missing", "Spatial result export requires a retained source-media reference.");
        try {
          sourceBytes = await input.media.read(result.sourceMediaRef);
        } catch {
          throw new ArtifactServiceError("source_missing", "The retained source image required for spatial export is unavailable.");
        }
      }
      try {
        const artifact = await exportResultArtifact({ root: currentRoot, result, ...(sourceBytes ? { sourceBytes } : {}) });
        try {
          if (!await input.results.setArtifactReference(result.id, artifact.absolutePath)) {
            throw new ArtifactServiceError("result_not_found", `Result ${id} disappeared before its artifact reference could be attached.`);
          }
        } catch (error) {
          await rm(artifact.absolutePath, { force: true }).catch(() => undefined);
          throw error;
        }
        return artifact;
      } catch (error) {
        if (error instanceof ArtifactServiceError) throw error;
        throw new ArtifactServiceError("export_failed", error instanceof Error ? error.message : "Artifact export failed.");
      }
    }
  };
}
