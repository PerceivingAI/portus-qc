import { readFile } from "node:fs/promises";
import type { AppConfig } from "./schema";
import { parseAppConfig } from "./schema";

const DEFAULTS_ROOT = new URL("../../../config/defaults/", import.meta.url);

async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, DEFAULTS_ROOT), "utf8")) as unknown;
}

export async function loadRepositoryDefaults(): Promise<AppConfig> {
  return parseAppConfig({
    runtime: await json("runtime.json"),
    inference: await json("inference.json"),
    camera: await json("camera.json"),
    console: await json("console.json"),
    scheduler: await json("scheduler.json"),
    video: await json("video.json"),
    media: await json("media.json"),
    artifacts: await json("artifacts.json")
  });
}
