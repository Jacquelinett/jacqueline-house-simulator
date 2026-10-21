import { buildModal } from "../ui/modal";
import { getSettings, updateSettings } from "./state";

export function setupSettingsModal(): { open: () => void } {
  const modal = buildModal("Settings");

  const section = document.createElement("div");
  section.id = "settings-broadcast-section";
  modal.body.appendChild(section);

  const heading = document.createElement("h3");
  heading.textContent = "Status broadcast";
  section.appendChild(heading);

  const hint = document.createElement("p");
  hint.className = "settings-hint";
  hint.textContent =
    "Paste the URL of your val.town status val, and the same secret you set as its HOUSE_SIM_SECRET environment variable.";
  section.appendChild(hint);

  const urlLabel = document.createElement("label");
  urlLabel.textContent = "Val.town URL";
  section.appendChild(urlLabel);

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.placeholder = "https://you--houseSimulatorStatus.web.val.run";
  section.appendChild(urlInput);

  const secretLabel = document.createElement("label");
  secretLabel.textContent = "Secret";
  section.appendChild(secretLabel);

  const secretInput = document.createElement("input");
  secretInput.type = "password";
  section.appendChild(secretInput);

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  section.appendChild(saveBtn);

  const savedNote = document.createElement("span");
  savedNote.className = "settings-saved-note";
  section.appendChild(savedNote);

  function loadIntoForm() {
    const settings = getSettings();
    urlInput.value = settings.broadcastUrl;
    secretInput.value = settings.broadcastSecret;
  }

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      await updateSettings({
        broadcastUrl: urlInput.value.trim().replace(/\/$/, ""),
        broadcastSecret: secretInput.value.trim(),
      });
      savedNote.textContent = "Saved";
      setTimeout(() => (savedNote.textContent = ""), 2000);
    } catch (err) {
      console.error("[settings] failed to save", err);
      savedNote.textContent = "Failed to save";
    } finally {
      saveBtn.disabled = false;
    }
  };

  loadIntoForm();

  return { open: modal.open };
}
