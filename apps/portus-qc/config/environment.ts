import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const repositoryDotEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseDotEnv(source: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const comment = value.search(/\s+#/u);
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }
    parsed[key] = unquote(value);
  }
  return parsed;
}

export async function loadDotEnvFile(path: string): Promise<NodeJS.ProcessEnv> {
  try {
    return parseDotEnv(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export function mergeEnvironment(dotenv: NodeJS.ProcessEnv, baseEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...dotenv, ...baseEnvironment };
}

export async function loadRootEnvironment(baseEnvironment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  return mergeEnvironment(await loadDotEnvFile(repositoryDotEnvPath), baseEnvironment);
}
