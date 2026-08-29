import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import type { BoxGeometry, MaskGeometry, PointGeometry } from "@portus-qc/contracts";
import type { StoredInspectionResult } from "../persistence/results";

export interface ExportedArtifact {
  absolutePath: string;
  mimeType: "text/plain" | "image/png";
}

function safeName(value: string, fallback: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64) || fallback;
}

function fileStem(result: StoredInspectionResult): string {
  const stamp = result.createdAt.replace(/[:.]/gu, "-");
  return `${stamp}-${safeName(result.inspectionId, "inspection")}-${result.capability}-${safeName(result.id, "result")}`;
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      await rename(temporary, path);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || (error.code !== "EEXIST" && error.code !== "EPERM")) throw error;
      await rm(path, { force: true });
      await rename(temporary, path);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function xmlAttribute(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function rect(box: BoxGeometry, width: number, height: number, stroke: number): string {
  const x = box.xMin * width;
  const y = box.yMin * height;
  const w = (box.xMax - box.xMin) * width;
  const h = (box.yMax - box.yMin) * height;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ff3b30" stroke-width="${stroke}"/>`;
}

function marker(point: PointGeometry, width: number, height: number, radius: number, stroke: number): string {
  const x = point.x * width;
  const y = point.y * height;
  return `<g><circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#ff3b30" stroke-width="${stroke}"/><line x1="${x - radius * 1.4}" y1="${y}" x2="${x + radius * 1.4}" y2="${y}" stroke="#ff3b30" stroke-width="${stroke}"/><line x1="${x}" y1="${y - radius * 1.4}" x2="${x}" y2="${y + radius * 1.4}" stroke="#ff3b30" stroke-width="${stroke}"/></g>`;
}

function segment(region: MaskGeometry, width: number, height: number, stroke: number): string {
  if (!region.bbox) throw new Error("Segment artifact export requires a bounding box for each normalized region.");
  const x = region.bbox.xMin * width;
  const y = region.bbox.yMin * height;
  const w = (region.bbox.xMax - region.bbox.xMin) * width;
  const h = (region.bbox.yMax - region.bbox.yMin) * height;
  const path = xmlAttribute(region.path);
  const transform = `translate(${x} ${y}) scale(${w} ${h})`;
  return `<path d="${path}" transform="${transform}" fill="none" stroke="#000000" stroke-opacity="0.78" stroke-width="${stroke * 2.5}" vector-effect="non-scaling-stroke"/><path d="${path}" transform="${transform}" fill="#58d9e8" fill-opacity="0.38" stroke="#7ce8f2" stroke-width="${stroke * 1.25}" vector-effect="non-scaling-stroke"/>`;
}

async function renderSpatial(result: StoredInspectionResult, sourceBytes: Uint8Array): Promise<Uint8Array> {
  if (sourceBytes.byteLength === 0) throw new Error("Spatial artifact export requires non-empty source image bytes.");
  const source = sharp(sourceBytes, { failOn: "error" });
  const metadata = await source.metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw new Error("Source image dimensions are unavailable for artifact rendering.");
  const stroke = Math.max(2, Math.min(width, height) * 0.004);
  const radius = Math.max(5, Math.min(width, height) * 0.012);
  let shapes: string;

  if (result.result.capability === "detect") {
    shapes = result.result.boxes.map((item) => rect(item, width, height, stroke)).join("");
  } else if (result.result.capability === "point") {
    shapes = result.result.points.map((item) => marker(item, width, height, radius, stroke)).join("");
  } else if (result.result.capability === "segment") {
    shapes = result.result.regions.map((item) => segment(item, width, height, stroke)).join("");
  } else {
    throw new Error(`Capability ${result.result.capability} does not produce a spatial image artifact.`);
  }

  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shapes}</svg>`);
  return new Uint8Array(await sharp(sourceBytes, { failOn: "error" }).composite([{ input: overlay, blend: "over" }]).png().toBuffer());
}

export async function exportResultArtifact(input: {
  root: string;
  result: StoredInspectionResult;
  sourceBytes?: Uint8Array;
}): Promise<ExportedArtifact> {
  const dateDirectory = input.result.createdAt.slice(0, 10);
  const stem = fileStem(input.result);
  if (input.result.result.capability === "query" || input.result.result.capability === "caption") {
    const absolutePath = join(input.root, dateDirectory, `${stem}.txt`);
    await atomicWrite(absolutePath, new TextEncoder().encode(`${input.result.result.text}\n`));
    return { absolutePath, mimeType: "text/plain" };
  }
  if (!input.sourceBytes) throw new Error("Spatial artifact export requires the retained source image referenced by the result.");
  const absolutePath = join(input.root, dateDirectory, `${stem}.png`);
  await atomicWrite(absolutePath, await renderSpatial(input.result, input.sourceBytes));
  return { absolutePath, mimeType: "image/png" };
}
