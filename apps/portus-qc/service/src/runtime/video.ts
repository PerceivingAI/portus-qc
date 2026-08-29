import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { CamsnapClip } from "@portus-qc/camsnap";
import type { InferenceImage } from "@portus-qc/contracts";
import { prepareInferenceImage } from "@portus-qc/engine";

export interface FfmpegProcessResult {
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
}

export type FfmpegProcessRunner = (executable: string, argv: readonly string[], timeoutMs: number) => Promise<FfmpegProcessResult>;

export interface VideoFrameExtractor {
  extract(input: {
    clip: CamsnapClip;
    cameraId: string;
    sessionId: string;
    frameId: string;
    frameTimestampMs: number;
  }): Promise<InferenceImage>;
}

export interface FfmpegFrameExtractorOptions {
  resolveExecutable(): Promise<string>;
  processRunner?: FfmpegProcessRunner;
  now?: () => string;
  timeoutMs?: number;
}

export class VideoFrameExtractionError extends Error {
  constructor(readonly code: "ffmpeg_failed" | "ffmpeg_timeout" | "invalid_output", message: string) {
    super(message);
    this.name = "VideoFrameExtractionError";
  }
}

async function runFfmpegProcess(executable: string, argv: readonly string[], timeoutMs: number): Promise<FfmpegProcessResult> {
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(executable, [...argv], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const finish = (result: FfmpegProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.once("error", () => finish({ exitCode: null, stderr, timedOut: false }));
    child.once("close", (code) => finish({ exitCode: code, stderr, timedOut }));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      hardKill.unref();
    }, timeoutMs);
    timer.unref();
  });
}

export function createFfmpegFrameExtractor(options: FfmpegFrameExtractorOptions): VideoFrameExtractor {
  const processRunner = options.processRunner ?? runFfmpegProcess;
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? 15_000;
  let executablePromise: Promise<string> | undefined;

  async function executable(): Promise<string> {
    executablePromise ??= options.resolveExecutable();
    try { return await executablePromise; }
    catch (error) { executablePromise = undefined; throw error; }
  }

  return {
    async extract(input): Promise<InferenceImage> {
      if (input.clip.bytes.byteLength === 0 || input.clip.mimeType !== "video/mp4") {
        throw new VideoFrameExtractionError("invalid_output", "Video clip must be a non-empty MP4 file.");
      }
      if (!Number.isFinite(input.frameTimestampMs) || input.frameTimestampMs < 0) {
        throw new VideoFrameExtractionError("invalid_output", "Video frame timestamp must be non-negative.");
      }
      const resolvedExecutable = await executable();
      const workDir = await mkdtemp(join(tmpdir(), "portus-qc-video-frame-"));
      const inputPath = join(workDir, "clip.mp4");
      const outputPath = join(workDir, "frame.jpg");
      try {
        await writeFile(inputPath, input.clip.bytes, { flag: "wx", mode: 0o600 });
        const result = await processRunner(resolvedExecutable, [
          "-hide_banner", "-loglevel", "error", "-y",
          "-i", inputPath,
          "-frames:v", "1",
          "-q:v", "2",
          outputPath
        ], timeoutMs);
        if (result.timedOut) throw new VideoFrameExtractionError("ffmpeg_timeout", "FFmpeg frame extraction timed out.");
        if (result.exitCode !== 0) throw new VideoFrameExtractionError("ffmpeg_failed", "FFmpeg could not extract a frame from the camera clip.");
        const bytes = new Uint8Array(await readFile(outputPath));
        if (bytes.byteLength === 0) throw new VideoFrameExtractionError("invalid_output", "FFmpeg produced an empty video frame.");
        const metadata = await sharp(bytes, { failOn: "error" }).metadata();
        if (!metadata.width || !metadata.height) throw new VideoFrameExtractionError("invalid_output", "Extracted video frame dimensions are unavailable.");
        const prepared = prepareInferenceImage({
          id: input.frameId,
          bytes,
          mimeType: "image/jpeg",
          width: metadata.width,
          height: metadata.height,
          orientationNormalized: true,
          source: {
            sourceId: input.cameraId,
            ...(input.clip.source.capturedAt ? { capturedAt: input.clip.source.capturedAt } : {}),
            receivedAt: now(),
            metadata: { videoSessionId: input.sessionId }
          }
        });
        return {
          ...prepared,
          coordinateSpace: {
            sourceWidth: metadata.width,
            sourceHeight: metadata.height,
            inferenceWidth: metadata.width,
            inferenceHeight: metadata.height,
            orientationNormalized: true,
            transform: "frame-extract"
          },
          frameTimestampMs: input.frameTimestampMs
        };
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  };
}
