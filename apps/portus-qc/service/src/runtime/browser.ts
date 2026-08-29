import { spawn } from "node:child_process";

export interface BrowserLaunchCommand {
  command: string;
  args: readonly string[];
}

export function browserLaunchCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserLaunchCommand {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "::1")) {
    throw new Error("Portus QC may auto-open only its loopback HTTP URL.");
  }
  if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

export async function openLocalBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const launch = browserLaunchCommand(url, platform);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args], { detached: platform !== "win32", stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
