import { buildModal } from "../ui/modal";
import { buildDisplaySettingsSection } from "../ui/displaySettings";
import { getSettings, onSettingsChange, updateSettings } from "./state";

/**
 * Display settings only — status broadcast config used to live here too,
 * but broadcastUrl/broadcastSecret are server-only config now
 * (server/serverConfig.ts, hand-edited on the home server), not something
 * any individual device sets, so that whole section is gone. Shared by
 * the desktop Settings modal and the mobile Settings tab.
 */
export function setupSettingsContent(container: HTMLElement): void {
  // Applying devMode/scale back onto the house isn't this function's job —
  // setupHouse()'s own onSettingsChange subscription reacts to the saved
  // value instead.
  const display = buildDisplaySettingsSection(container, getSettings(), {
    onDevModeChange: async (value) => {
      try {
        await updateSettings({ devMode: value });
      } catch (err) {
        console.error("[settings] failed to save dev mode", err);
      }
    },
    onThemeChange: async (value) => {
      try {
        await updateSettings({ theme: value });
      } catch (err) {
        console.error("[settings] failed to save theme", err);
      }
    },
    onScaleChange: async (value) => {
      try {
        await updateSettings({ scale: value });
      } catch (err) {
        console.error("[settings] failed to save scale", err);
      }
    },
  });

  // The desktop modal and the mobile tab each build their own independent
  // instance of this section — settings/state.ts's existing reactive
  // subscription (already relied on elsewhere, e.g. setupHouse() applying
  // devMode/scale) is what keeps both in sync, instead of one silently
  // going stale until reload whenever the other one changes something.
  onSettingsChange(() => display.update(getSettings()));
}

export function setupSettingsModal(): { open: () => void } {
  const modal = buildModal("Settings", { resizable: true });
  setupSettingsContent(modal.body);
  return { open: modal.open };
}
