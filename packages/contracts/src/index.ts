export type Id = string;
export type IsoTimestamp = string;

export interface SourceMetadata {
  sourceId?: Id;
  capturedAt?: IsoTimestamp;
  receivedAt: IsoTimestamp;
  metadata?: Readonly<Record<string, string>>;
}

export interface CoordinateSpace {
  sourceWidth: number;
  sourceHeight: number;
  inferenceWidth: number;
  inferenceHeight: number;
  orientationNormalized: boolean;
  transform: "identity" | "resize" | "crop" | "transcode" | "frame-extract";
}

export interface InferenceImage {
  id: Id;
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  source: SourceMetadata;
  coordinateSpace?: CoordinateSpace;
  frameTimestampMs?: number;
}

export interface RecordedVideoFrame { id: Id; timestampMs: number; image: InferenceImage; }

export type VisionCapability = "query" | "caption" | "detect" | "point" | "segment";
export interface VisionRequest { capability: VisionCapability; image: InferenceImage; prompt: string; findingId?: string; metadataField?: string; }

export interface BoxGeometry { xMin: number; yMin: number; xMax: number; yMax: number; }
export interface PointGeometry { x: number; y: number; }
export interface MaskGeometry { path: string; bbox?: BoxGeometry; }

export interface QueryResult {
  capability: "query";
  text: string;
}

export interface CaptionResult {
  capability: "caption";
  text: string;
}

export interface DetectResult {
  capability: "detect";
  boxes: readonly BoxGeometry[];
}

export interface PointResult {
  capability: "point";
  points: readonly PointGeometry[];
}

export interface SegmentResult {
  capability: "segment";
  regions: readonly MaskGeometry[];
}

export type VisionResult = QueryResult | CaptionResult | DetectResult | PointResult | SegmentResult;
export type VisionResultFor<C extends VisionCapability> = Extract<VisionResult, { capability: C }>;

export interface VisionResponse<R extends VisionResult = VisionResult> {
  capability: R["capability"];
  result: R;
  provider: string;
  model: string;
  requestId?: string;
  durationMs?: number;
  usage?: Record<string, number>;
}
export interface VisionProvider {
  readonly id: string;
  readonly model: string;
  supports(capability: VisionCapability): boolean;
  execute(request: VisionRequest): Promise<VisionResponse>;
}

export interface EvidenceAssociation { type: "same-finding" | "same-frame" | "derived-from"; evidenceId: Id; }
export interface Evidence {
  id: Id;
  kind: "box" | "point" | "mask" | "text" | "structured";
  findingId?: string;
  metadataField?: string;
  value: unknown;
  frameId: Id;
  provider: string;
  model: string;
  requestId?: string;
  associations?: readonly EvidenceAssociation[];
}

export type ScreeningDecision = "PASS" | "REVIEW" | "FAIL";
export interface ProfileVisionStep {
  id: string;
  capability: VisionCapability;
  prompt: string;
  findingId?: string;
  metadataField?: string;
  required: boolean;
}
export interface ScreeningProfile {
  id: string;
  version: number;
  screeningPlan: readonly ProfileVisionStep[];
}

export interface ProviderCallAudit {
  capability: VisionCapability | "classify";
  provider: string;
  model: string;
  status: "success" | "failed";
  requestId?: string;
  durationMs?: number;
  usage?: Readonly<Record<string, number>>;
  errorCode?: string;
}

export interface ScreeningResult {
  id: Id;
  profileId: string;
  profileVersion: number;
  decision: ScreeningDecision;
  evidence: readonly Evidence[];
  metrics: Readonly<Record<string, number | string | boolean | null>>;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
  providerCalls: readonly ProviderCallAudit[];
  createdAt: IsoTimestamp;
}

export * from "./calibration";
