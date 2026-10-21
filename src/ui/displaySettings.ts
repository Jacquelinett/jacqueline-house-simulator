import { Theme } from "../settings/types";

export interface DisplaySettingsValues {
  devMode: boolean;
  theme: Theme;
  scale: number;
}

export interface DisplaySettingsCallbacks {
  onDevModeChange(value: boolean): void;
  onThemeChange(value: Theme): void;
  onScaleChange(value: number): void;
}

/**
 * The "Display" section (dev-mode checkbox, theme select, zoom slider) —
 * identical markup/labels in the desktop app's Settings modal and the
 * viewer's own, which previously hand-rolled a near-identical copy. What
 * differs between them is only how a change gets persisted (Tauri fs +
 * reactive subscription on the desktop, direct localStorage write in the
 * viewer) — left entirely to the callbacks, not this function.
 */
export function buildDisplaySettingsSection(
  parent: HTMLElement,
  initial: DisplaySettingsValues,
  callbacks: DisplaySettingsCallbacks,
): void {
  const section = document.createElement("div");
  section.id = "settings-display-section";
  parent.appendChild(section);

  const heading = document.createElement("h3");
  heading.textContent = "Display";
  section.appendChild(heading);

  const devModeLabel = document.createElement("label");
  devModeLabel.className = "settings-checkbox-row";
  const devModeCheckbox = document.createElement("input");
  devModeCheckbox.type = "checkbox";
  devModeCheckbox.checked = initial.devMode;
  devModeLabel.appendChild(devModeCheckbox);
  devModeLabel.appendChild(document.createTextNode(" Dev mode (show hitbox outlines)"));
  section.appendChild(devModeLabel);
  devModeCheckbox.onchange = () => callbacks.onDevModeChange(devModeCheckbox.checked);

  const themeRow = document.createElement("label");
  themeRow.className = "settings-scale-row";
  themeRow.textContent = "Theme";
  const themeSelect = document.createElement("select");
  for (const [value, label] of [
    ["dark", "Dark"],
    ["pink", "Pink"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    themeSelect.appendChild(opt);
  }
  themeSelect.value = initial.theme;
  themeRow.appendChild(themeSelect);
  section.appendChild(themeRow);
  themeSelect.onchange = () => callbacks.onThemeChange(themeSelect.value as Theme);

  const scaleRow = document.createElement("label");
  scaleRow.className = "settings-scale-row";
  scaleRow.textContent = "Zoom";
  const scaleInput = document.createElement("input");
  scaleInput.type = "range";
  scaleInput.min = "1";
  scaleInput.max = "4";
  scaleInput.step = "0.25";
  scaleInput.value = String(initial.scale);
  scaleRow.appendChild(scaleInput);
  const scaleValue = document.createElement("span");
  scaleValue.className = "settings-scale-value";
  scaleValue.textContent = `${initial.scale}×`;
  scaleRow.appendChild(scaleValue);
  section.appendChild(scaleRow);
  scaleInput.oninput = () => {
    scaleValue.textContent = `${scaleInput.value}×`;
  };
  scaleInput.onchange = () => callbacks.onScaleChange(Number(scaleInput.value));
}
