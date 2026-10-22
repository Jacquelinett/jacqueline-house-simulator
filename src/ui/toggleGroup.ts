/**
 * A row of mutually-exclusive buttons (single-select, as opposed to the
 * multi-select day-of-week toggles in goals/ui.ts) — plain DOM, zero
 * Tauri/AW dependency, so both the desktop Statistic modal and the
 * viewer's own Statistic surface can use it. `buttonClass` picks which
 * look it gets: `"stat-tab"` for real tab navigation (switches which
 * section is visible) vs the default `"day-toggle"` pill style (picks a
 * parameter within a section) — kept visually distinct on purpose so the
 * two don't read as the same kind of control.
 */
export function buildToggleGroup<T extends string>(
  options: readonly (readonly [T, string])[],
  initial: T,
  onChange: (value: T) => void,
  buttonClass: "day-toggle" | "stat-tab" = "day-toggle",
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
