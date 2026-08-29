import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const requiredFiles = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY.md",
  "docs/INSTALL.md",
  "docs/RELEASE.md",
  "apps/portus-qc/vendor/camsnap/LICENSE.txt",
  "apps/portus-qc/vendor/camsnap/PROVENANCE.md"
];
const bundledBinaries = [
  {
    path: "apps/portus-qc/vendor/camsnap/windows-x64/camsnap.exe",
    sha256: "3557a03cfc4232f2ade3ef2c68b610d3821caca6922ce1de89fe2076426e9479"
  }
];
const workspacePackages = [
  "package.json",
  "apps/portus-qc/package.json",
  "packages/contracts/package.json",
  "packages/media/package.json",
  "packages/screening-core/package.json",
  "packages/engine/package.json",
  "packages/vision/package.json",
  "packages/camsnap/package.json",
  "packages/inspection-config/package.json"
];

const failures = [];
async function text(path) {
  try { return await readFile(path, "utf8"); }
  catch { failures.push(`Missing required release file: ${path}`); return ""; }
}
async function json(path) {
  const source = await text(path);
  if (!source) return {};
  try { return JSON.parse(source); }
  catch { failures.push(`Invalid JSON in ${path}`); return {}; }
}
function requireCondition(condition, message) { if (!condition) failures.push(message); }
async function releaseFiles() {
  try {
    const gitRoot = resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim());
    if (gitRoot === resolve(process.cwd())) {
      return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    }
  } catch {
    // A staged source tree may intentionally have no Git metadata yet.
  }

  const output = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "coverage", ".portus-qc"].includes(entry.name)) continue;
      const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) output.push(path.replaceAll("\\", "/"));
    }
  }
  await walk(".");
  return output;
}
function isPublicTextPath(path) {
  if (/(?:^|\/)(?:test|tests)(?:\/|$)|\.test\.[^/]+$/iu.test(path)) return false;
  return /(?:^|\/)(?:[^/]+\.(?:css|html|js|json|md|mjs|ts|txt|yaml|yml)|\.gitignore)$/iu.test(path);
}
async function markdownFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) output.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) output.push(path);
  }
  return output;
}

for (const path of requiredFiles) await text(path);
for (const binary of bundledBinaries) {
  try {
    const bytes = await readFile(binary.path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    requireCondition(sha256 === binary.sha256, `${binary.path} must match the pinned Camsnap checksum.`);
  } catch {
    failures.push(`Missing required bundled binary: ${binary.path}`);
  }
}


for (const path of workspacePackages) {
  const pkg = await json(path);
  requireCondition(pkg.license === "Apache-2.0", `${path} must declare license Apache-2.0.`);
}

const root = await json("package.json");
const app = await json("apps/portus-qc/package.json");
const lock = await json("package-lock.json");
const ignore = await text(".gitignore");
const readme = await text("README.md");
const thirdParty = await text("THIRD_PARTY.md");

requireCondition(root.private === true, "Root workspace must remain private to prevent accidental npm publication.");
requireCondition(app.private === true, "Bundled app workspace must remain private to prevent accidental npm publication.");
requireCondition(root.engines?.node === ">=22.13.0", "Root Node engine floor must remain >=22.13.0.");
requireCondition(root.allowScripts?.esbuild === false, "esbuild install scripts must remain explicitly denied unless release review changes that decision.");
requireCondition(lock.lockfileVersion === 3, "package-lock.json must remain lockfileVersion 3.");
requireCondition(lock.packages?.[""]?.license === "Apache-2.0", "Lockfile root metadata must preserve Apache-2.0.");
requireCondition(ignore.includes(".env"), ".gitignore must exclude local .env secrets.");
requireCondition(ignore.includes(".p10-capture-profile-*/"), ".gitignore must exclude local browser verification profiles.");
const releaseFileList = await releaseFiles();
requireCondition(!releaseFileList.some((path) => /^\.p10-capture-profile-/u.test(path)), "Generated browser verification profiles must never be present in the public source tree.");
for (const path of releaseFileList.filter(isPublicTextPath)) {
  let source;
  try { source = await readFile(path, "utf8"); }
  catch { continue; }
  const developerHomePath = /(?:[A-Za-z]:[\\/]Users[\\/][^\\/<>\s]+[\\/]|\/Users\/[^/<>\s]+\/|\/home\/[^/<>\s]+\/)/u;
  requireCondition(!developerHomePath.test(source), `${path} contains a concrete developer-home absolute path; use a platform variable or placeholder instead.`);
}
requireCondition(readme.includes("npm ci") && readme.includes("npm start") && readme.includes("npm run doctor"), "README must document install, launch, and Doctor commands.");
for (const dependency of ["sharp", "@img/sharp-win32-x64", "@img/colour", "detect-libc", "semver"]) {
  requireCondition(thirdParty.includes(`\`${dependency}\``), `THIRD_PARTY.md must inventory ${dependency}.`);
}
const forbiddenLegacyName = ["Product", "Screener"].join(" ");
for (const path of ["README.md", "SECURITY.md", "THIRD_PARTY.md", ...await markdownFiles("docs")]) {
  const source = await text(path);
  requireCondition(!source.includes(forbiddenLegacyName), `${path} contains private/product-era naming that must not ship in Portus QC.`);
}

if (failures.length) {
  console.error("Portus QC release metadata check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Portus QC release metadata check passed (${workspacePackages.length} workspace manifests, ${requiredFiles.length} required public files).`);
}
