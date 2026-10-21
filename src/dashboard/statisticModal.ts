import { buildModal } from "../ui/modal";
import { getActivityStats } from "./stats";
import { renderAllTimeActivity } from "./render";
import { getGoalHistory, GoalHistoryEntry } from "../goals/history";

/** All-time standouts — opened on demand from the "Statistic" button, as opposed to the always-visible Dashboard panel's today-only data. */
export function setupStatisticModal(): { open: () => void } {
  const modal = buildModal("Statistic", { size: "large" });

  const goalsHeading = document.createElement("h3");
  goalsHeading.className = "panel-section-heading";
  goalsHeading.textContent = "All-Time Goals";
  modal.body.appendChild(goalsHeading);

  const goalsList = document.createElement("div");
  goalsList.id = "dashboard-alltime-goals-list";
  modal.body.appendChild(goalsList);

  const activityHeading = document.createElement("h3");
  activityHeading.className = "panel-section-heading";
  activityHeading.textContent = "All-Time Activity (top 5)";
  modal.body.appendChild(activityHeading);

  const pie = document.createElement("div");
  pie.id = "dashboard-pie";
  modal.body.appendChild(pie);

  const activityList = document.createElement("div");
  activityList.className = "dashboard-list";
  modal.body.appendChild(activityList);

  // Aggregated by activity label, not per-goal — "most completed/skipped
  // activity" is about the activity overall, not whichever specific
  // recurring goal happens to track it (and skips showing e.g. a
  // Sunday-only goal's history on a random Wednesday, which a flat
  // per-goal list would otherwise do regardless of today's date).
  //
  // Goal history never leaves this app (nothing pushes it to val.town), so
  // this section is desktop-only — the viewer's own Statistic modal only
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
    open() {
      modal.open();
      renderGoals();
      renderActivity();
    },
  };
}
