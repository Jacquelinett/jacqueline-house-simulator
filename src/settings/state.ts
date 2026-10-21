import { loadSettings, saveSettings } from "./store";
import { DEFAULT_SETTINGS, Settings } from "./types";

let settings: Settings = { ...DEFAULT_SETTINGS };
const listeners = new Set<() => void>();

export async function initSettingsState(): Promise<void> {
  settings = await loadSettings();
}

export function getSettings(): Settings {
  return settings;
}

export function onSettingsChange(cb: () => void): void {
  listeners.add(cb);
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  settings = { ...settings, ...patch };
  await saveSettings(settings);
  for (const cb of listeners) cb();
}
