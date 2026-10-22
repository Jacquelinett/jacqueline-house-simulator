import { buildModal } from "../ui/modal";
import { getActivityStats, getActivityStatsForRange } from "./stats";
import { renderAllTimeActivity, renderGoalList } from "./render";
import { getGoalHistory, summarizeGoalHistory } from "../goals/history";
import { getGoalProgressForRange } from "../goals/progress";
import { localDateString, parseDateString } from "../goals/recurrence";

/**
 * A row of mutually-exclusive buttons (single-select, as opposed to the
 * multi-select day-of-week toggles in goals/ui.ts) — used twice below, with
 * different classNames so the two don't read as the same kind of control:
 * All Time/Period is real tab navigation (`stat-tab`, underline style) that
 * swaps which section is visible, while Weekly/Monthly is a toggle/radio
 * pair (`day-toggle`, the same pill style used everywhere else in this app)
 * that just changes a parameter within the Period section. Small enough to
 * keep local rather than promoting to a shared ui/ module until a third
 * caller shows up.
 */
function buildToggleGroup<T extends string>(
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

type PeriodMode = "weekly" | "monthly";

function periodRange(mode: PeriodMode, anchor: Date): { start: Date; end: Date; label: string } {
  if (mode === "weekly") {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay());
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    const lastDay = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
    const label = `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${lastDay.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
    return { start, end, label };
  }
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  return { start, end, label: start.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
}

/**
 * All-time standouts (goals + activity) — shared by the desktop Statistic
 * modal (opened on demand) and the mobile Statistic tab. Unlike the
 * Dashboard content, this doesn't auto-refresh on an interval — the caller
 * calls `refresh()` whenever this becomes visible (modal open, or tab
 * switch), since all-time data is expensive enough to scan that there's
 * no reason to keep re-fetching it while nobody's looking.
 */
export function setupStatisticContent(container: HTMLElement): { refresh(): void } {
  let activeTab: "all" | "period" = "all";

  const tabsRow = document.createElement("div");
  tabsRow.className = "stat-tabs";
  container.appendChild(tabsRow);

  const allTimeSection = document.createElement("div");
  container.appendChild(allTimeSection);

  const periodSection = document.createElement("div");
  periodSection.style.display = "none";
  container.appendChild(periodSection);

  tabsRow.appendChild(
    buildToggleGroup(
      [
        ["all", "All Time"],
        ["period", "Period"],
      ] as const,
      "all",
      (tab) => {
        activeTab = tab;
        allTimeSection.style.display = tab === "all" ? "" : "none";
        periodSection.style.display = tab === "period" ? "" : "none";
        if (tab === "period") refreshPeriod();
      },
      "stat-tab",
    ),
  );

  // --- All Time ---

  const goalsHeading = document.createElement("h3");
  goalsHeading.className = "panel-section-heading";
  goalsHeading.textContent = "All-Time Goals";
  allTimeSection.appendChild(goalsHeading);

  const goalsList = document.createElement("div");
  goalsList.id = "dashboard-alltime-goals-list";
  allTimeSection.appendChild(goalsList);

  const activityHeading = document.createElement("h3");
  activityHeading.className = "panel-section-heading";
  activityHeading.textContent = "All-Time Activity (top 5)";
  allTimeSection.appendChild(activityHeading);

  const pie = document.createElement("div");
  pie.id = "dashboard-pie";
  allTimeSection.appendChild(pie);

  const activityList = document.createElement("div");
  activityList.className = "dashboard-list";
  allTimeSection.appendChild(activityList);

  // Aggregated by activity label, not per-goal — "most completed/skipped
  // activity" is about the activity overall, not whichever specific
  // recurring goal happens to track it (and skips showing e.g. a
  // Sunday-only goal's history on a random Wednesday, which a flat
  // per-goal list would otherwise do regardless of today's date).
  //
  // Goal history never leaves this app (nothing pushes it to val.town), so
  // this section is desktop-only — the viewer's own Statistic surface only
  // has the Activity half below.
  function renderGoals() {
    goalsList.textContent = "";
    const history = getGoalHistory();

    if (history.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No history yet";
      goalsList.appendChild(empty);
      return;
    }

    const { mostCompleted, mostSkipped } = summarizeGoalHistory(history);

    const completedRow = document.createElement("div");
    completedRow.className = "dashboard-row";
    completedRow.textContent = mostCompleted
      ? `Most completed: ${mostCompleted.label} (${mostCompleted.count}×)`
      : "Most completed: —";
    goalsList.appendChild(completedRow);

    const skippedRow = document.createElement("div");
    skippedRow.className = "dashboard-row";
    skippedRow.textContent = mostSkipped
      ? `Most skipped: ${mostSkipped.label} (${mostSkipped.count}×)`
      : "Most skipped: —";
    goalsList.appendChild(skippedRow);
  }

  async function renderActivity() {
    activityList.textContent = "";
    const loading = document.createElement("div");
    loading.className = "goals-empty";
    loading.textContent = "Loading...";
    activityList.appendChild(loading);

    const stats = await getActivityStats().catch((err) => {
      console.error("[statistic] failed to load stats", err);
      return null;
    });

    if (!stats) {
      activityList.textContent = "";
      const error = document.createElement("div");
      error.className = "goals-empty";
      error.textContent = "Failed to load stats";
      activityList.appendChild(error);
      return;
    }

    renderAllTimeActivity(pie, activityList, stats);
  }

  // --- Period (Weekly/Monthly) ---

  let mode: PeriodMode = "weekly";

  const controlsRow = document.createElement("div");
  controlsRow.className = "stat-period-controls";
  periodSection.appendChild(controlsRow);

  controlsRow.appendChild(
    buildToggleGroup(
      [
        ["weekly", "Weekly"],
        ["monthly", "Monthly"],
      ] as const,
      "weekly",
      (value) => {
        mode = value;
        refreshPeriod();
      },
    ),
  );

  const periodDateInput = document.createElement("input");
  periodDateInput.type = "date";
  periodDateInput.value = localDateString(new Date());
  periodDateInput.onchange = refreshPeriod;
  controlsRow.appendChild(periodDateInput);

  const rangeLabel = document.createElement("div");
  rangeLabel.className = "stat-period-range-label";
  periodSection.appendChild(rangeLabel);

  const periodGoalsHeading = document.createElement("h3");
  periodGoalsHeading.className = "panel-section-heading";
  periodGoalsHeading.textContent = "Period Goals";
  periodSection.appendChild(periodGoalsHeading);

  const periodGoalsList = document.createElement("div");
  periodGoalsList.className = "dashboard-list";
  periodSection.appendChild(periodGoalsList);

  const periodOutcomesHeading = document.createElement("h3");
  periodOutcomesHeading.className = "panel-section-heading";
  periodOutcomesHeading.textContent = "Period Goal Outcomes";
  periodSection.appendChild(periodOutcomesHeading);

  const periodOutcomesList = document.createElement("div");
  periodSection.appendChild(periodOutcomesList);

  const periodActivityHeading = document.createElement("h3");
  periodActivityHeading.className = "panel-section-heading";
  periodActivityHeading.textContent = "Period Activity";
  periodSection.appendChild(periodActivityHeading);

  const periodPie = document.createElement("div");
  periodPie.id = "dashboard-period-pie";
  periodSection.appendChild(periodPie);

  const periodActivityList = document.createElement("div");
  periodActivityList.className = "dashboard-list";
  periodSection.appendChild(periodActivityList);

  async function refreshPeriod() {
    const { start, end, label } = periodRange(mode, parseDateString(periodDateInput.value));
    rangeLabel.textContent = label;

    const progress = await getGoalProgressForRange(start, end);
    renderGoalList(
      periodGoalsList,
      progress.map((p) => ({ ...p, subRows: [] })),
      "No goals that period",
    );

    const startStr = localDateString(start);
    const endStr = localDateString(end);
    const history = getGoalHistory().filter((h) => h.date >= startStr && h.date < endStr);
    const { mostCompleted, mostSkipped } = summarizeGoalHistory(history);

    periodOutcomesList.textContent = "";
    const completedRow = document.createElement("div");
    completedRow.className = "dashboard-row";
    completedRow.textContent = mostCompleted
      ? `Most completed: ${mostCompleted.label} (${mostCompleted.count}×)`
      : "Most completed: —";
    periodOutcomesList.appendChild(completedRow);

    const skippedRow = document.createElement("div");
    skippedRow.className = "dashboard-row";
    skippedRow.textContent = mostSkipped ? `Most skipped: ${mostSkipped.label} (${mostSkipped.count}×)` : "Most skipped: —";
    periodOutcomesList.appendChild(skippedRow);

    const stats = await getActivityStatsForRange(start, end).catch((err) => {
      console.error("[statistic] failed to load period stats", err);
      return null;
    });
    if (!stats) {
      periodActivityList.textContent = "";
      const error = document.createElement("div");
      error.className = "goals-empty";
      error.textContent = "Failed to load stats";
      periodActivityList.appendChild(error);
      return;
    }
    renderAllTimeActivity(periodPie, periodActivityList, stats);
  }

  return {
    refresh() {
      renderGoals();
      renderActivity();
      if (activeTab === "period") refreshPeriod();
    },
  };
}

/** Opened on demand from the "Statistic" button, as opposed to the always-visible Dashboard panel's today-only data. */
export function setupStatisticModal(): { open: () => void } {
  const modal = buildModal("Statistic", { size: "large", resizable: true });
  const content = setupStatisticContent(modal.body);

  return {
    open() {
      modal.open();
      content.refresh();
    },
  };
}
