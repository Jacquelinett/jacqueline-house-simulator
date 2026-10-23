/**
 * Tiny shared DOM builders for the label/value row (and its optional
 * sub-row) pattern that the Workout modal's tabs (src/workout/modal.ts,
 * also reused as the mobile Workout tab) and the viewer's own wger summary
 * section (src/viewer-main.ts's renderWgerSummary) both repeated
 * byte-for-byte for Lifetime Stats/Personal Records/Log rows — see
 * CLAUDE.md's "reuse over duplication" principle.
 *
 * Deliberately NOT a bigger "render these rows for this data shape"
 * abstraction: the two surfaces show different (and differently-complete)
 * row SETS for the same underlying data — e.g. the viewer's Lifetime Stats
 * block omits "Last workout," already covered by its own adjacent Recent
 * Days section a few rows down, while the desktop modal's standalone
 * Lifetime tab has no such neighbor and keeps that row. Forcing one shared
 * row-list would mean either changing one of those two deliberately
 * different outputs or threading a flag through just to suppress a row, so
 * only the common single-row DOM shape is shared here, not the
 * data-to-rows decision — each call site still builds its own row list.
 */
export function buildWorkoutRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "dashboard-row workout-row";

  const name = document.createElement("span");
  name.className = "dashboard-text";
  name.textContent = label;
  row.appendChild(name);

  const detail = document.createElement("span");
  detail.className = "workout-sets-detail";
  detail.textContent = value;
  row.appendChild(detail);

  return row;
}

/** The lighter-weight line under a `buildWorkoutRow` — a record's date, a session's impression, an extra weight/rep group, etc. */
export function buildWorkoutSubRow(text: string): HTMLElement {
  const subRow = document.createElement("div");
  subRow.className = "workout-subrow";

  const subText = document.createElement("span");
  subText.className = "workout-subtext";
  subText.textContent = text;
  subRow.appendChild(subText);

  return subRow;
}
