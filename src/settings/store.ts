import { BaseDirectory } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { DEFAULT_SETTINGS, Settings } from "./types";

const FILE_NAME = "settings.json";
const OPTS = { baseDir: BaseDirectory.AppData };

export async function loadSettings(): Promise<Settings> {
  if (!(await exists(FILE_NAME, OPTS))) return { ...DEFAULT_SETTINGS };
  const text = await readTextFile(FILE_NAME, OPTS);
  return { ...DEFAULT_SETTINGS, ...(JSON.parse(text) as Partial<Settings>) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir("", { ...OPTS, recursive: true });
  await writeTextFile(FILE_NAME, JSON.stringify(settings, null, 2), OPTS);
}
