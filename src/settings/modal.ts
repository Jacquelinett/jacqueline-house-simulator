import { buildModal } from "../ui/modal";
import { getSettings, updateSettings } from "./state";

export function setupSettingsModal(): { open: () => void } {
  const modal = buildModal("Settings");

  const displaySection = document.createElement("div");
  displaySection.id = "settings-display-section";
  modal.body.appendChild(displaySection);

  const displayHeading = document.createElement("h3");
  displayHeading.textContent = "Display";
  displaySection.appendChild(displayHeading);

  const devModeLabel = document.createElement("label");
  devModeLabel.className = "settings-checkbox-row";
  const devModeCheckbox = document.createElement("input");
  devModeCheckbox.type = "checkbox";
  devModeLabel.appendChild(devModeCheckbox);
  devModeLabel.appendChild(document.createTextNode(" Dev mode (show hitbox outlines)"));
  displaySection.appendChild(devModeLabel);
  devModeCheckbox.onchange = async () => {
    try {
      await updateSettings({ devMode: devModeCheckbox.checked });
    } catch (err) {
      console.error("[settings] failed to save dev mode", err);
    }
  };

  const scaleRow = document.createElement("label");
  scaleRow.className = "settings-scale-row";
  scaleRow.textContent = "Zoom";
  const scaleInput = document.createElement("input");
  scaleInput.type = "range";
  scaleInput.min = "1";
  scaleInput.max = "4";
  scaleInput.step = "0.25";
  scaleRow.appendChild(scaleInput);
  const scaleValue = document.createElement("span");
  scaleValue.className = "settings-scale-value";
  scaleRow.appendChild(scaleValue);
  displaySection.appendChild(scaleRow);
  scaleInput.oninput = () => {
    scaleValue.textContent = `${scaleInput.value}×`;
  };
  scaleInput.onchange = async () => {
    try {
      await updateSettings({ scale: Number(scaleInput.value) });
    } catch (err) {
      console.error("[settings] failed to save scale", err);
    }
  };

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
    devModeCheckbox.checked = settings.devMode;
    scaleInput.value = String(settings.scale);
    scaleValue.textContent = `${settings.scale}×`;
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
