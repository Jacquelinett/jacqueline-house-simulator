/**
 * A row of mutually-exclusive buttons (single-select, as opposed to the
 * multi-select day-of-week toggles in goals/ui.ts) — plain DOM, zero
 * Tauri/AW dependency, so both app and viewer builds can use it.
 * `buttonClass` picks which look it gets — e.g. `"stat-tab"` for real tab
 * navigation (switches which section is visible), the default
 * `"day-toggle"` pill style (picks a parameter within a section), or the
 * viewer Dashboard's own `"day-link"` hyperlink style — kept visually
 * distinct per use so different kinds of control don't read as the same
 * thing. A plain `string` rather than a closed union so a new visual
 * variant doesn't require editing this file too.
 */
export function buildToggleGroup<T extends string>(
  options: readonly (readonly [T, string])[],
  initial: T,
  onChange: (value: T) => void,
  buttonClass: string = "day-toggle",
): HTMLElement {
  const group = document.createElement("span");
  const buttons = new Map<T, HTMLButtonElement>();
  let current = initial;
  for (const [value, label] of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.className = buttonClass + (value === initial ? " selected" : "");
    btn.onclick = () => {
      if (value === current) return;
      current = value;
      for (const [v, b] of buttons) b.classList.toggle("selected", v === value);
      onChange(value);
    };
    buttons.set(value, btn);
    group.appendChild(btn);
  }
  return group;
}
