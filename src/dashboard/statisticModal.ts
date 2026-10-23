import { buildModal } from "../ui/modal";
import { buildToggleGroup } from "../ui/toggleGroup";
import { getActivityStats } from "./stats";
import { renderAllTimeActivity, renderGoalList, renderGoalOutcomes } from "./render";
import { getGoalHistory, summarizeGoalHistory } from "../goals/history";
import { computePeriodStats } from "./periodStats";
import { localDateString, parseDateString, periodRange, PeriodMode } from "../goals/recurrence";
import { setupWorkoutContent } from "../workout/modal";

/**
 * All-time standouts (goals + activity) and real wger workout data — the
 * desktop app's Statistic modal content, shared with the mobile Statistic
 * tab (same split as every other modal/mobile-tab pair in this app).
 * Two outer tabs (.stat-tab, the same underline style the modal always
 * used): Goals (the all-time/period goal+activity content this used to be
 * the entirety of) and Workout (src/workout/modal.ts's own content,
 * previously its own separate top-level modal/mobile-tab/menu button —
 * folded in here once it became clear "Workout gets its own menu on
 * desktop but lives under Statistic on the viewer" was an inconsistency
 * worth fixing rather than a deliberate difference; see src/viewer-main.ts's
 * buildStatisticBlock for the viewer's own copy of this same Goals/Workout
 * split). Unlike the Dashboard content, none of this auto-refreshes on an
 * interval — the caller calls `refresh()` whenever this becomes visible
 * (modal open, or tab switch), since all-time data is expensive enough to
 * scan that there's no reason to keep re-fetching it while nobody's
 * looking; switching outer or inner tabs lazily refreshes whichever
 * becomes active, the same pattern the old All Time/Period toggle alone
 * used to use.
 */
export function setupStatisticContent(container: HTMLElement): { refresh(): void } {
  let activeOuterTab: "goals" | "workout" = "goals";

  const outerTabsRow = document.createElement("div");
  outerTabsRow.className = "stat-tabs";
  container.appendChild(outerTabsRow);

  const goalsSection = document.createElement("div");
  container.appendChild(goalsSection);

  const workoutSection = document.createElement("div");
  workoutSection.style.display = "none";
  container.appendChild(workoutSection);

  const workoutContent = setupWorkoutContent(workoutSection);

  outerTabsRow.appendChild(
    buildToggleGroup(
      [
        ["goals", "Goals"],
        ["workout", "Workout"],
      ] as const,
      "goals",
      (tab) => {
        activeOuterTab = tab;
        goalsSection.style.display = tab === "goals" ? "" : "none";
        workoutSection.style.display = tab === "workout" ? "" : "none";
        if (tab === "goals") refreshGoals();
        else workoutContent.refresh();
      },
      "stat-tab",
    ),
  );

  // --- Goals: All Time / Period (inner segmented toggle) ---

  let activeInnerTab: "all" | "period" = "all";

  const innerToggleRow = document.createElement("div");
  innerToggleRow.className = "segment-toggle-row";
  goalsSection.appendChild(innerToggleRow);

  const allTimeSection = document.createElement("div");
  goalsSection.appendChild(allTimeSection);

  const periodSection = document.createElement("div");
  periodSection.style.display = "none";
  goalsSection.appendChild(periodSection);

  innerToggleRow.appendChild(
    buildToggleGroup(
      [
        ["all", "All Time"],
        ["period", "Period"],
      ] as const,
      "all",
      (tab) => {
        activeInnerTab = tab;
        allTimeSection.style.display = tab === "all" ? "" : "none";
        periodSection.style.display = tab === "period" ? "" : "none";
        if (tab === "period") refreshPeriod();
      },
      "segment-toggle-btn",
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
  // gets per-window goal outcomes for the 4 fixed buckets it's pushed (see
  // periodStats.ts), never the full all-time history.
  async function renderGoals() {
    renderGoalOutcomes(goalsList, summarizeGoalHistory(await getGoalHistory()));
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
    periodGoalsHeading.textContent = `Period Goals — ${label}`;

    const { goalProgress, mostCompleted, mostSkipped, activityStats } = await computePeriodStats(start, end);

    renderGoalList(
      periodGoalsList,
      goalProgress.map((p) => ({ ...p, subRows: [] })),
      "No goals that period",
    );
    renderGoalOutcomes(periodOutcomesList, { mostCompleted, mostSkipped });
    renderAllTimeActivity(periodPie, periodActivityList, activityStats);
  }

  async function refreshGoals() {
    renderGoals();
    renderActivity();
    if (activeInnerTab === "period") refreshPeriod();
  }

  return {
    refresh() {
      if (activeOuterTab === "goals") refreshGoals();
      else workoutContent.refresh();
    },
  };
}

/** Opened on demand from the "Statistic" button, as opposed to the always-visible Dashboard panel's one-day-at-a-time data. */
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
