import { createPersistedState } from "../lib/persistedState";
import { settingsFileStore } from "./store";
import { Settings } from "./types";

const settingsState = createPersistedState(settingsFileStore.load, settingsFileStore.save);

export const initSettingsState = settingsState.init;
export const getSettings = settingsState.get;
export const onSettingsChange = settingsState.onChange;

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  await settingsState.persist({ ...getSettings(), ...patch });
}
