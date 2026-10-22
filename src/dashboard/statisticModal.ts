import { buildModal } from "../ui/modal";
import { getActivityStats } from "./stats";
import { renderAllTimeActivity } from "./render";
import { getGoalHistory, GoalHistoryEntry } from "../goals/history";

/**
 * All-time standouts (goals + activity) — shared by the desktop Statistic
 * modal (opened on demand) and the mobile Statistic tab. Unlike the
 * Dashboard content, this doesn't auto-refresh on an interval — the caller
 * calls `refresh()` whenever this becomes visible (modal open, or tab
 * switch), since all-time data is expensive enough to scan that there's
 * no reason to keep re-fetching it while nobody's looking.
 */
export function setupStatisticContent(container: HTMLElement): { refresh(): void } {
  const goalsHeading = document.createElement("h3");
  goalsHeading.className = "panel-section-heading";
  goalsHeading.textContent = "All-Time Goals";
  container.appendChild(goalsHeading);

  const goalsList = document.createElement("div");
  goalsList.id = "dashboard-alltime-goals-list";
  container.appendChild(goalsList);

  const activityHeading = document.createElement("h3");
  activityHeading.className = "panel-section-heading";
  activityHeading.textContent = "All-Time Activity (top 5)";
  container.appendChild(activityHeading);

  const pie = document.createElement("div");
  pie.id = "dashboard-pie";
  container.appendChild(pie);

  const activityList = document.createElement("div");
  activityList.className = "dashboard-list";
  container.appendChild(activityList);

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

    const byLabel = new Map<string, Record<GoalHistoryEntry["outcome"], number>>();
    for (const entry of history) {
      const counts = byLabel.get(entry.activityLabel) ?? { completed: 0, skipped: 0, missed: 0 };
      counts[entry.outcome]++;
      byLabel.set(entry.activityLabel, counts);
    }

    let mostCompleted: { label: string; count: number } | null = null;
    let mostSkipped: { label: string; count: number } | null = null;
    for (const [label, counts] of byLabel) {
      if (counts.completed > 0 && (!mostCompleted || counts.completed > mostCompleted.count)) {
        mostCompleted = { label, count: counts.completed };
      }
      if (counts.skipped > 0 && (!mostSkipped || counts.skipped > mostSkipped.count)) {
        mostSkipped = { label, count: counts.skipped };
      }
    }

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

  return {
    refresh() {
      renderGoals();
      renderActivity();
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
