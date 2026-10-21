import { buildModal } from "../ui/modal";
import { getActivityStats } from "./stats";
import { formatMinutes } from "../goals/ui";
import { toCssColor } from "../scene/activities";
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
  activityList.id = "dashboard-list";
  modal.body.appendChild(activityList);

  // Aggregated by activity label, not per-goal — "most completed/skipped
  // activity" is about the activity overall, not whichever specific
  // recurring goal happens to track it (and skips showing e.g. a
  // Sunday-only goal's history on a random Wednesday, which a flat
  // per-goal list would otherwise do regardless of today's date).
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

    activityList.textContent = "";
    if (!stats) {
      const error = document.createElement("div");
      error.className = "goals-empty";
      error.textContent = "Failed to load stats";
      activityList.appendChild(error);
      return;
    }

    // Capped so this doesn't just grow forever as more activities get added
    // — already sorted by all-time total, so "top 5" is the 5 biggest.
    const topStats = stats.slice(0, 5);

    // The pie represents each activity's share of average daily time (how a
    // typical day splits up), not all-time totals — a newer activity
    // shouldn't look negligible forever just because it started later.
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
      pie.style.background = `conic-gradient(${stops.join(", ")})`;
    } else {
      pie.style.background = "rgba(255, 255, 255, 0.1)";
    }

    if (topStats.every((s) => s.totalMinutesAllTime === 0)) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No tracked time yet";
      activityList.appendChild(empty);
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

      activityList.appendChild(row);
    }
  }

  return {
    open() {
      modal.open();
      renderGoals();
      renderActivity();
    },
  };
}
