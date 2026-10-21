import { BaseDirectory } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Goal } from "./types";

const FILE_NAME = "goals.json";
const OPTS = { baseDir: BaseDirectory.AppData };

export async function loadGoals(): Promise<Goal[]> {
  if (!(await exists(FILE_NAME, OPTS))) return [];
  const text = await readTextFile(FILE_NAME, OPTS);
  return JSON.parse(text) as Goal[];
}

export async function saveGoals(goals: Goal[]): Promise<void> {
  // $APPDATA itself isn't guaranteed to exist yet on first run — nothing else
  // writes there, so writeTextFile would otherwise fail with "not found".
  // recursive:true is a no-op (like mkdir -p) if it already exists.
  await mkdir("", { ...OPTS, recursive: true });
  await writeTextFile(FILE_NAME, JSON.stringify(goals, null, 2), OPTS);
}
