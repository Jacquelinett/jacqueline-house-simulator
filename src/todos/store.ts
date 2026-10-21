import { BaseDirectory } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Todo } from "./types";

const FILE_NAME = "todos.json";
const OPTS = { baseDir: BaseDirectory.AppData };

export async function loadTodos(): Promise<Todo[]> {
  if (!(await exists(FILE_NAME, OPTS))) return [];
  const text = await readTextFile(FILE_NAME, OPTS);
  return JSON.parse(text) as Todo[];
}

export async function saveTodos(todos: Todo[]): Promise<void> {
  // $APPDATA itself isn't guaranteed to exist yet on first run — recursive:true
  // is a no-op (like mkdir -p) if it already exists.
  await mkdir("", { ...OPTS, recursive: true });
  await writeTextFile(FILE_NAME, JSON.stringify(todos, null, 2), OPTS);
}
