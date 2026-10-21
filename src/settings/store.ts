import { createJsonFileStore } from "../lib/jsonFileStore";
import { DEFAULT_SETTINGS, Settings } from "./types";

const fileStore = createJsonFileStore<Partial<Settings>>("settings.json", {});

// Settings specifically needs a merge-with-defaults on load (not just
// handled by jsonFileStore's "file missing" case) so a settings.json saved
// before a new field existed (e.g. devMode/scale added after broadcastUrl)
// still comes back with that field populated instead of undefined.
export const settingsFileStore = {
  async load(): Promise<Settings> {
    return { ...DEFAULT_SETTINGS, ...(await fileStore.load()) };
  },
  save: fileStore.save,
};
