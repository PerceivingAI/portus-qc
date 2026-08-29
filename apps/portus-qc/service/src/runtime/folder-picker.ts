import { spawn } from "node:child_process";
import { resolveExecutablePath } from "./executable";

export class FolderPickerUnavailableError extends Error {
  constructor(message = "No supported native folder picker is available on this system.") {
    super(message);
    this.name = "FolderPickerUnavailableError";
  }
}

export interface FolderPicker {
  pick(initialPath: string): Promise<string | undefined>;
}

async function run(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, [...args], {
      env: environment,
      shell: false,
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve(stdout.trim() || undefined);
      if (code === 1 && (!stderr.trim() || /cancel(?:ed|led)?/iu.test(stderr))) return resolve(undefined);
      reject(new FolderPickerUnavailableError(stderr.trim() || `Folder picker exited with code ${code ?? "unknown"}.`));
    });
  });
}

export function createNativeFolderPicker(options: {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): FolderPicker {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  return {
    async pick(initialPath: string): Promise<string | undefined> {
      if (platform === "win32") {
        const executable = await resolveExecutablePath("powershell.exe", { platform, environment, cwd })
          ?? await resolveExecutablePath("powershell", { platform, environment, cwd });
        if (!executable) throw new FolderPickerUnavailableError("PowerShell is required for the Windows folder picker.");
        const pickerEnvironment = { ...environment, PORTUS_QC_PICKER_INITIAL: initialPath };
        const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Select Portus QC results folder'; if (Test-Path -LiteralPath $env:PORTUS_QC_PICKER_INITIAL) { $d.SelectedPath=$env:PORTUS_QC_PICKER_INITIAL }; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }";
        return run(executable, ["-NoProfile", "-STA", "-NonInteractive", "-Command", script], pickerEnvironment);
      }

      if (platform === "darwin") {
        const executable = await resolveExecutablePath("/usr/bin/osascript", { platform, environment, cwd });
        if (!executable) throw new FolderPickerUnavailableError("osascript is required for the macOS folder picker.");
        return run(executable, ["-e", "POSIX path of (choose folder with prompt \"Select Portus QC results folder\")"], environment);
      }

      const zenity = await resolveExecutablePath("zenity", { platform, environment, cwd });
      if (zenity) return run(zenity, ["--file-selection", "--directory", "--title=Select Portus QC results folder", `--filename=${initialPath}/`], environment);
      const kdialog = await resolveExecutablePath("kdialog", { platform, environment, cwd });
      if (kdialog) return run(kdialog, ["--getexistingdirectory", initialPath, "--title", "Select Portus QC results folder"], environment);
      throw new FolderPickerUnavailableError();
    }
  };
}
