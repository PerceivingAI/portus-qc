import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(ROOT, "packages");
const APPS = join(ROOT, "apps");

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function workspaceManifests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, "package.json");
    try {
      manifests.push({ path, manifest: JSON.parse(await readFile(path, "utf8")) });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return manifests;
}

function allDependencies(manifest) {
  return Object.keys({
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {})
  });
}

const packageManifests = await workspaceManifests(PACKAGES);
const appManifests = await workspaceManifests(APPS);
const appNames = new Set(appManifests.map(({ manifest }) => manifest.name).filter(Boolean));
const errors = [];

for (const { path, manifest } of packageManifests) {
  const location = relative(ROOT, path).replaceAll(sep, "/");
  if (typeof manifest.name !== "string" || !manifest.name.startsWith("@portus-qc/")) {
    errors.push(`${location}: reusable package name must use @portus-qc/*.`);
  }
  for (const dependency of allDependencies(manifest)) {
    if (appNames.has(dependency)) errors.push(`${location}: reusable package depends on application workspace ${dependency}.`);
  }
}

for (const { path, manifest } of appManifests) {
  const location = relative(ROOT, path).replaceAll(sep, "/");
  if (manifest.private !== true) errors.push(`${location}: bundled application workspace must remain private.`);
}

const packageFiles = await filesUnder(PACKAGES);
const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu;
for (const path of packageFiles) {
  if (!/\.(?:ts|tsx|js|mjs|cjs)$/u.test(path)) continue;
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) continue;
    const resolved = resolve(dirname(path), specifier);
    if (resolved === APPS || resolved.startsWith(`${APPS}${sep}`)) {
      errors.push(`${relative(ROOT, path).replaceAll(sep, "/")}: reusable source imports application path ${specifier}.`);
    }
  }
  if (source.includes("apps/portus-qc") || source.includes("apps\\portus-qc")) {
    errors.push(`${relative(ROOT, path).replaceAll(sep, "/")}: reusable source contains application path reference.`);
  }
}

if (errors.length > 0) {
  console.error("Portus QC structural boundary check failed:\n" + errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Portus QC structural boundary check passed (${packageManifests.length} reusable packages, ${appManifests.length} application workspace).`);
}
