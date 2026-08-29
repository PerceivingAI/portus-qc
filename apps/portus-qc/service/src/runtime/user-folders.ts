import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { resolveExecutablePath } from "./executable";

const WINDOWS_DOWNLOADS_GUID = "{374DE290-123F-4565-9164-39C4925E467B}";
const WINDOWS_USER_SHELL_FOLDERS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

function fallbackDownloads(platform: NodeJS.Platform, homeDirectory: string): string {
  return pathApi(platform).join(homeDirectory, "Downloads");
}

function expandWindowsEnvironment(value: string, environment: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/gu, (match, name: string) => environment[name] ?? environment[name.toUpperCase()] ?? environment[name.toLowerCase()] ?? match);
}

async function commandOutput(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(executable, [...args], { env: environment, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => resolve(code === 0 ? stdout : undefined));
  });
}

async function windowsDownloads(environment: NodeJS.ProcessEnv, homeDirectory: string): Promise<string> {
  const fallback = fallbackDownloads("win32", homeDirectory);
  const executable = await resolveExecutablePath("reg.exe", { platform: "win32", environment });
  if (!executable) return fallback;
  const output = await commandOutput(executable, ["query", WINDOWS_USER_SHELL_FOLDERS, "/v", WINDOWS_DOWNLOADS_GUID], environment);
  const match = output?.match(/\s+REG_(?:EXPAND_)?SZ\s+(.+)$/imu);
  if (!match?.[1]) return fallback;
  const expanded = expandWindowsEnvironment(match[1].trim(), environment);
  return win32.isAbsolute(expanded) ? win32.normalize(expanded) : fallback;
}

function decodeXdgValue(raw: string, homeDirectory: string): string | undefined {
  let value = raw.trim();
  if (value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1);
  value = value.replaceAll("\\\"", "\"").replaceAll("\\\\", "\\");
  value = value.replace(/^\$HOME(?=\/|$)/u, homeDirectory).replace(/^\$\{HOME\}(?=\/|$)/u, homeDirectory);
  return posix.isAbsolute(value) ? posix.normalize(value) : undefined;
}

async function linuxDownloads(environment: NodeJS.ProcessEnv, homeDirectory: string): Promise<string> {
  const explicit = environment.XDG_DOWNLOAD_DIR;
  if (explicit) {
    const decoded = decodeXdgValue(explicit, homeDirectory);
    if (decoded) return decoded;
  }
  const configRoot = environment.XDG_CONFIG_HOME || posix.join(homeDirectory, ".config");
  try {
    const text = await readFile(posix.join(configRoot, "user-dirs.dirs"), "utf8");
    const match = /^XDG_DOWNLOAD_DIR=(.+)$/mu.exec(text);
    if (match?.[1]) {
      const decoded = decodeXdgValue(match[1], homeDirectory);
      if (decoded) return decoded;
    }
  } catch {
    // XDG user directories are optional; fall back to ~/Downloads.
  }
  return fallbackDownloads("linux", homeDirectory);
}

export async function discoverDownloadsDirectory(options: {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
} = {}): Promise<string> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  if (platform === "win32") return windowsDownloads(environment, homeDirectory);
  if (platform === "linux") return linuxDownloads(environment, homeDirectory);
  return fallbackDownloads(platform, homeDirectory);
}
