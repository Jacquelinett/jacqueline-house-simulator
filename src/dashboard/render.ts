import { formatMinutes } from "../goals/ui";
import { toCssColor } from "../scene/activities";

/**
 * Builds the "Today's Goals" / divider / "Today's Activity" skeleton
 * shared by the desktop Dashboard panel and the viewer's equivalent
 * section — the heading text and layout only need to be right in one
 * place instead of two copies silently drifting apart.
 */
export function buildDashboardSections(container: HTMLElement): {
  goalList: HTMLElement;
  activityList: HTMLElement;
} {
  const goalHeading = document.createElement("h3");
  goalHeading.className = "panel-section-heading";
  goalHeading.textContent = "Today's Goals";
  container.appendChild(goalHeading);

  const goalList = document.createElement("div");
  goalList.className = "dashboard-list";
  container.appendChild(goalList);

  const divider = document.createElement("div");
  divider.className = "panel-divider";
  container.appendChild(divider);

  const activityHeading = document.createElement("h3");
  activityHeading.className = "panel-section-heading";
  activityHeading.textContent = "Today's Activity";
  container.appendChild(activityHeading);

  const activityList = document.createElement("div");
  activityList.className = "dashboard-list";
  container.appendChild(activityList);

  return { goalList, activityList };
}

export interface DashboardGoalEntry {
  activityLabel: string;
  minutes: number;
  targetMinutes: number;
  done: boolean;
  // Pre-formatted sub-row text (schedule + target) for each goal
  // contributing to this entry's combined total.
  subRows: string[];
}

export function renderGoalList(container: HTMLElement, entries: DashboardGoalEntry[]): void {
  container.textContent = "";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "goals-empty";
    empty.textContent = "No goals today";
    container.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "goal-row" + (entry.done ? " goal-done" : "");

    const check = document.createElement("span");
    check.className = "goal-check";
    check.textContent = entry.done ? "☑" : "☐";
    row.appendChild(check);

    const text = document.createElement("span");
    text.className = "goal-text";
    text.textContent = `${entry.activityLabel} — ${formatMinutes(entry.minutes)} / ${formatMinutes(entry.targetMinutes)}`;
    row.appendChild(text);

    container.appendChild(row);

    for (const subText of entry.subRows) {
      const subRow = document.createElement("div");
      subRow.className = "goal-subrow";

      const subTextEl = document.createElement("span");
      subTextEl.className = "goal-subtext";
      subTextEl.textContent = subText;
      subRow.appendChild(subTextEl);

      container.appendChild(subRow);
    }
  }
}

export interface DashboardActivityEntry {
  label: string;
  color: number;
  minutes: number;
}

export function renderActivityList(container: HTMLElement, entries: DashboardActivityEntry[], emptyText: string): void {
  container.textContent = "";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "goals-empty";
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "dashboard-row";

    const swatch = document.createElement("span");
    swatch.className = "dashboard-swatch";
    swatch.style.background = toCssColor(e.color);
    row.appendChild(swatch);

    const text = document.createElement("span");
    text.className = "dashboard-text";
    text.textContent = `${e.label} — ${formatMinutes(e.minutes)}`;
    row.appendChild(text);

    container.appendChild(row);
  }
}
