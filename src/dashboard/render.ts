import { formatMinutes } from "../goals/format";
import { toCssColor } from "../scene/activities";
import type { ActivityStat } from "./stats";
import type { WorkoutTodayEntry } from "../workout/format";

/**
 * Builds the "Today's Goals" / divider / "Today's Activity" / "Lifted
 * Today" skeleton shared by the desktop Dashboard panel and the viewer's
 * equivalent section — the heading text and layout only need to be right
 * in one place instead of two copies silently drifting apart.
 *
 * `workoutSection` wraps its own divider + heading + list as one unit so
 * renderWorkoutToday() (below) can hide all three together with one
 * `display` toggle — unlike Goals/Activity, this section is meant to
 * disappear entirely (no heading, no "nothing logged" placeholder row)
 * when there's nothing to show, since it's a "pride" callout, not an
 * always-present status area.
 */
export function buildDashboardSections(container: HTMLElement): {
  goalHeading: HTMLElement;
  goalList: HTMLElement;
  activityHeading: HTMLElement;
  activityList: HTMLElement;
  workoutSection: HTMLElement;
  workoutList: HTMLElement;
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

  const workoutSection = document.createElement("div");
  workoutSection.className = "workout-today-section";
  workoutSection.style.display = "none";
  container.appendChild(workoutSection);

  const workoutDivider = document.createElement("div");
  workoutDivider.className = "panel-divider";
  workoutSection.appendChild(workoutDivider);

  const workoutHeading = document.createElement("h3");
  workoutHeading.className = "panel-section-heading";
  workoutHeading.textContent = "Lifted Today";
  workoutSection.appendChild(workoutHeading);

  const workoutList = document.createElement("div");
  workoutList.className = "dashboard-list";
  workoutSection.appendChild(workoutList);

  return { goalHeading, goalList, activityHeading, activityList, workoutSection, workoutList };
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

export function renderGoalList(container: HTMLElement, entries: DashboardGoalEntry[], emptyText = "No goals today"): void {
  container.textContent = "";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "goals-empty";
    empty.textContent = emptyText;
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

/**
 * "Lifted Today" — real logged wger sets (or [] for a mock/no-data day),
 * already grouped-by-exercise via src/workout/format.ts's
 * summarizeWorkoutSessions() by the caller. Hides `section` entirely
 * (heading, divider, list, all of it) when there's nothing to show,
 * rather than rendering an empty-state placeholder the way
 * renderGoalList/renderActivityList do — see buildDashboardSections's own
 * comment on why this section behaves differently.
 */
export function renderWorkoutToday(section: HTMLElement, list: HTMLElement, entries: WorkoutTodayEntry[]): void {
  if (entries.length === 0) {
    section.style.display = "none";
    list.textContent = "";
    return;
  }

  section.style.display = "";
  list.textContent = "";
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "dashboard-row workout-row";

    const name = document.createElement("span");
    name.className = "dashboard-text";
    name.textContent = entry.exerciseName;
    row.appendChild(name);

    const detail = document.createElement("span");
    detail.className = "workout-sets-detail";
    detail.textContent = entry.detail;
    row.appendChild(detail);

    list.appendChild(row);
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

/**
 * All-time activity pie (share of average daily time, not raw totals — a
 * newer activity shouldn't look negligible forever just because it started
 * later) + legend, capped to the top 5 so this doesn't just grow forever as
 * more activities get added. Shared by the desktop Statistic modal and the
 * viewer's equivalent.
 */
export function renderAllTimeActivity(pieEl: HTMLElement, listEl: HTMLElement, stats: ActivityStat[]): void {
  const topStats = stats.slice(0, 5);

  const dailyTotal = topStats.reduce((sum, s) => sum + s.averageMinutesPerDay, 0);
  if (dailyTotal > 0) {
    let cursor = 0;
    const stops: string[] = [];
    for (const s of topStats) {
      if (s.averageMinutesPerDay <= 0) continue;
      const start = (cursor / dailyTotal) * 100;
      cursor += s.averageMinutesPerDay;
      const end = (cursor / dailyTotal) * 100;
      stops.push(`${toCssColor(s.color)} ${start}% ${end}%`);
    }
    pieEl.style.background = `conic-gradient(${stops.join(", ")})`;
  } else {
    pieEl.style.background = "rgba(255, 255, 255, 0.1)";
  }

  listEl.textContent = "";
  if (topStats.every((s) => s.totalMinutesAllTime === 0)) {
    const empty = document.createElement("div");
    empty.className = "goals-empty";
    empty.textContent = "No tracked time yet";
    listEl.appendChild(empty);
    return;
  }

  for (const s of topStats) {
    const row = document.createElement("div");
    row.className = "dashboard-row";

    const swatch = document.createElement("span");
    swatch.className = "dashboard-swatch";
    swatch.style.background = toCssColor(s.color);
    row.appendChild(swatch);

    const text = document.createElement("span");
    text.className = "dashboard-text";
    text.textContent = `${s.label} — ${formatMinutes(s.totalMinutesAllTime)} total, ${formatMinutes(s.averageMinutesPerDay)}/day avg`;
    row.appendChild(text);

    listEl.appendChild(row);
  }
}

export interface GoalOutcomesSummary {
  mostCompleted: { label: string; count: number } | null;
  mostSkipped: { label: string; count: number } | null;
}

/**
 * "Most completed"/"most skipped" rows from a goal-history summary — used
 * by the Statistic modal's All Time tab (summarized from all history) and
 * Period tab (summarized from history filtered to one window), plus the
 * viewer's own Period section (fed from whichever pre-computed fixed
 * bucket is selected). `emptyText` shows instead of the two rows only when
 * there's truly nothing to report (no completions *or* skips ever/in that
 * window) — a window with only "missed" outcomes still shows both rows
 * with a "—" placeholder, since that's a real (if discouraging) result,
 * not the same as no data existing at all.
 */
export function renderGoalOutcomes(container: HTMLElement, summary: GoalOutcomesSummary, emptyText = "No history yet"): void {
  container.textContent = "";

  if (!summary.mostCompleted && !summary.mostSkipped) {
    const empty = document.createElement("div");
    empty.className = "goals-empty";
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  const completedRow = document.createElement("div");
  completedRow.className = "dashboard-row";
  completedRow.textContent = summary.mostCompleted
    ? `Most completed: ${summary.mostCompleted.label} (${summary.mostCompleted.count}×)`
    : "Most completed: —";
  container.appendChild(completedRow);

  const skippedRow = document.createElement("div");
  skippedRow.className = "dashboard-row";
  skippedRow.textContent = summary.mostSkipped
    ? `Most skipped: ${summary.mostSkipped.label} (${summary.mostSkipped.count}×)`
    : "Most skipped: —";
  container.appendChild(skippedRow);
}
