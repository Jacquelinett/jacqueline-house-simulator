import { AmbientManualStop, Theme } from "../settings/types";
import { buildToggleGroup } from "./toggleGroup";

export interface DisplaySettingsValues {
  devMode: boolean;
  theme: Theme;
  scale: number;
  ambientUseRealTime: boolean;
  ambientManualStop: AmbientManualStop;
}

export interface DisplaySettingsCallbacks {
  onDevModeChange(value: boolean): void;
  onThemeChange(value: Theme): void;
  onScaleChange(value: number): void;
  onAmbientUseRealTimeChange(value: boolean): void;
  onAmbientManualStopChange(value: AmbientManualStop): void;
}

const AMBIENT_MANUAL_STOP_LABELS: Record<AmbientManualStop, string> = {
  night: "Night",
  dawn: "Dawn",
  day: "Day",
  dusk: "Dusk",
};

/**
 * The "Display" section (dev-mode checkbox, theme select, zoom slider) —
 * identical markup/labels in the desktop app's Settings modal and the
 * viewer's own, which previously hand-rolled a near-identical copy. What
 * differs between them is only how a change gets persisted (Tauri fs +
 * reactive subscription on the desktop, direct localStorage write in the
 * viewer) — left entirely to the callbacks, not this function.
 *
 * Both the desktop app and the viewer now also build a *second*,
 * independent instance of this section for the mobile tab — the returned
 * `update()` lets a caller re-sync one instance's displayed values after
 * a change made through the other one, instead of the two silently
 * drifting apart until the next reload.
 */
export function buildDisplaySettingsSection(
  parent: HTMLElement,
  initial: DisplaySettingsValues,
  callbacks: DisplaySettingsCallbacks,
): { update(values: DisplaySettingsValues): void } {
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

  // Ambient lighting (day/night tint) testing controls — "real time" pins
  // the tint to the house's own clock (America/New_York, see
  // scene/renderer.ts), which is the normal/default behavior; unchecking
  // it freezes the tint on one manually-picked mode so each look can be
  // previewed on demand instead of waiting for the real day/night cycle
  // to reach it.
  const ambientHeading = document.createElement("h3");
  ambientHeading.textContent = "Ambient Lighting";
  section.appendChild(ambientHeading);

  const ambientRealTimeLabel = document.createElement("label");
  ambientRealTimeLabel.className = "settings-checkbox-row";
  const ambientRealTimeCheckbox = document.createElement("input");
  ambientRealTimeCheckbox.type = "checkbox";
  ambientRealTimeCheckbox.checked = initial.ambientUseRealTime;
  ambientRealTimeLabel.appendChild(ambientRealTimeCheckbox);
  ambientRealTimeLabel.appendChild(document.createTextNode(" Use real time (Jacqueline's — EST/New York)"));
  section.appendChild(ambientRealTimeLabel);

  const ambientStopRow = document.createElement("div");
  ambientStopRow.className = "settings-scale-row";
  section.appendChild(ambientStopRow);

  // Rebuilt (not patched in place) on every mode change/external update —
  // buildToggleGroup has no resync hook of its own, and a handful of
  // buttons is cheap enough to just recreate, same spirit as rebuildSprite
  // elsewhere in this app favoring a clean rebuild over partial patching.
  let ambientStopButtons: HTMLElement | null = null;
  function renderAmbientStopButtons(current: AmbientManualStop) {
    const next = buildToggleGroup(
      (["night", "dawn", "day", "dusk"] as const).map((v) => [v, AMBIENT_MANUAL_STOP_LABELS[v]] as const),
      current,
      (value) => callbacks.onAmbientManualStopChange(value),
    );
    next.style.display = ambientRealTimeCheckbox.checked ? "none" : "";
    if (ambientStopButtons) ambientStopButtons.replaceWith(next);
    else ambientStopRow.appendChild(next);
    ambientStopButtons = next;
  }
  renderAmbientStopButtons(initial.ambientManualStop);

  ambientRealTimeCheckbox.onchange = () => {
    callbacks.onAmbientUseRealTimeChange(ambientRealTimeCheckbox.checked);
    if (ambientStopButtons) ambientStopButtons.style.display = ambientRealTimeCheckbox.checked ? "none" : "";
  };

  return {
    update(values) {
      devModeCheckbox.checked = values.devMode;
      themeSelect.value = values.theme;
      scaleInput.value = String(values.scale);
      scaleValue.textContent = `${values.scale}×`;
      ambientRealTimeCheckbox.checked = values.ambientUseRealTime;
      renderAmbientStopButtons(values.ambientManualStop);
    },
  };
}
