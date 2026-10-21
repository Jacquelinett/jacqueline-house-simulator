import { BaseDirectory } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

/** A single JSON file in the app's data directory, with a default value for when it doesn't exist yet. */
export function createJsonFileStore<T>(fileName: string, defaultValue: T) {
  const opts = { baseDir: BaseDirectory.AppData };

  return {
    async load(): Promise<T> {
      if (!(await exists(fileName, opts))) return defaultValue;
      const text = await readTextFile(fileName, opts);
      return JSON.parse(text) as T;
    },
    async save(value: T): Promise<void> {
      // $APPDATA itself isn't guaranteed to exist yet on first run — recursive:true
      // is a no-op (like mkdir -p) if it already exists.
      await mkdir("", { ...opts, recursive: true });
      await writeTextFile(fileName, JSON.stringify(value, null, 2), opts);
    },
  };
}
