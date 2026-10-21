import { buildModal } from "../ui/modal";

/** Placeholder — nothing configurable yet. Wired up now so the button exists once something needs it. */
export function setupSettingsModal(): { open: () => void } {
  const modal = buildModal("Settings");

  const placeholder = document.createElement("div");
  placeholder.className = "goals-empty";
  placeholder.textContent = "Nothing to configure yet.";
  modal.body.appendChild(placeholder);

  return { open: modal.open };
}
