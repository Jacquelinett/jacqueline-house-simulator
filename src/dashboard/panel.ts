import { buildFloatingPanel } from "../ui/draggablePanel";
import { getActivityStats, getTodayActivityStats } from "./stats";
import { formatMinutes } from "../goals/ui";
import { toCssColor } from "../scene/activities";
import { getTodayGoalProgress } from "../goals/progress";
import { getGoalHistory, GoalHistoryEntry } from "../goals/history";

type Tab = "goals" | "activity";

export function setupDashboardPanel(): { open: () => void } {
  const panel = buildFloatingPanel("Dashboard");

  const tabRow = document.createElement("div");
  tabRow.id = "dashboard-tabs";
  panel.body.appendChild(tabRow);

  const goalsTabBtn = document.createElement("button");
  goalsTabBtn.textContent = "Goals";
  tabRow.appendChild(goalsTabBtn);

  const activityTabBtn = document.createElement("button");
  activityTabBtn.textContent = "Activity";
  tabRow.appendChild(activityTabBtn);

  const goalsPane = document.createElement("div");
  goalsPane.id = "dashboard-goals-pane";
  panel.body.appendChild(goalsPane);

  const activityPane = document.createElement("div");
  activityPane.id = "dashboard-activity-pane";
  panel.body.appendChild(activityPane);

  function showTab(tab: Tab) {
    goalsPane.style.display = tab === "goals" ? "" : "none";
    activityPane.style.display = tab === "activity" ? "" : "none";
    goalsTabBtn.classList.toggle("active", tab === "goals");
    activityTabBtn.classList.toggle("active", tab === "activity");
  }
  goalsTabBtn.onclick = () => showTab("goals");
  activityTabBtn.onclick = () => showTab("activity");
  showTab("goals");

  // --- Activity pane: today's plain list, then all-time pie + totals ---
  const todayActivityHeading = document.createElement("h3");
  todayActivityHeading.className = "dashboard-section-heading";
  todayActivityHeading.textContent = "Today Activity";
  activityPane.appendChild(todayActivityHeading);

  const todayActivityList = document.createElement("div");
  todayActivityList.id = "dashboard-today-activity-list";
  activityPane.appendChild(todayActivityList);

  const allTimeActivityHeading = document.createElement("h3");
  allTimeActivityHeading.className = "dashboard-section-heading";
  allTimeActivityHeading.textContent = "All-Time Activity";
  activityPane.appendChild(allTimeActivityHeading);

  const pie = document.createElement("div");
  pie.id = "dashboard-pie";
  activityPane.appendChild(pie);

  const activityList = document.createElement("div");
  activityList.id = "dashboard-list";
  activityPane.appendChild(activityList);

  async function renderTodayActivity() {
    todayActivityList.textContent = "";
    const stats = await getTodayActivityStats().catch((err) => {
      console.error("[dashboard] failed to load today's activity", err);
      return null;
    });

    if (!stats) {
      const error = document.createElement("div");
      error.className = "goals-empty";
      error.textContent = "Failed to load";
      todayActivityList.appendChild(error);
      return;
    }

    if (stats.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "Nothing tracked today";
      todayActivityList.appendChild(empty);
      return;
    }

    for (const s of stats) {
      const row = document.createElement("div");
      row.className = "dashboard-row";

      const swatch = document.createElement("span");
      swatch.className = "dashboard-swatch";
      swatch.style.background = toCssColor(s.color);
      row.appendChild(swatch);

      const text = document.createElement("span");
      text.className = "dashboard-text";
      text.textContent = `${s.label} — ${formatMinutes(s.minutes)}`;
      row.appendChild(text);

      todayActivityList.appendChild(row);
    }
  }

  async function renderAllTimeActivity() {
    activityList.textContent = "";
    const loading = document.createElement("div");
    loading.className = "goals-empty";
    loading.textContent = "Loading...";
    activityList.appendChild(loading);

    const stats = await getActivityStats().catch((err) => {
      console.error("[dashboard] failed to load stats", err);
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

    // The pie represents each activity's share of average daily time (how a
    // typical day splits up), not all-time totals — a newer activity
    // shouldn't look negligible forever just because it started later.
    const dailyTotal = stats.reduce((sum, s) => sum + s.averageMinutesPerDay, 0);
    if (dailyTotal > 0) {
      let cursor = 0;
      const stops: string[] = [];
      for (const s of stats) {
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

    if (stats.every((s) => s.totalMinutesAllTime === 0)) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No tracked time yet";
      activityList.appendChild(empty);
      return;
    }

    for (const s of stats) {
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

  // --- Goals pane: what's scheduled today, plus all-time standouts ---
  const todayHeading = document.createElement("h3");
  todayHeading.className = "dashboard-section-heading";
  todayHeading.textContent = "Today's Goals";
  goalsPane.appendChild(todayHeading);

  const todayList = document.createElement("div");
  todayList.id = "dashboard-today-goals-list";
  goalsPane.appendChild(todayList);

  const allTimeHeading = document.createElement("h3");
  allTimeHeading.className = "dashboard-section-heading";
  allTimeHeading.textContent = "All-Time Goals";
  goalsPane.appendChild(allTimeHeading);

  const allTimeList = document.createElement("div");
  allTimeList.id = "dashboard-alltime-goals-list";
  goalsPane.appendChild(allTimeList);

  async function renderTodayGoals() {
    todayList.textContent = "";
    const progress = await getTodayGoalProgress();

    if (progress.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No goals today";
      todayList.appendChild(empty);
      return;
    }

    for (const { activityLabel, minutes, targetMinutes, done } of progress) {
      const row = document.createElement("div");
      row.className = "dashboard-row";
      row.textContent = `${done ? "☑" : "☐"} ${activityLabel} — ${formatMinutes(minutes)} / ${formatMinutes(targetMinutes)}`;
      todayList.appendChild(row);
    }
  }

  // Aggregated by activity label, not per-goal — "most completed/skipped
  // activity" is about the activity overall, not whichever specific
  // recurring goal happens to track it (and skips showing e.g. a
  // Sunday-only goal's history on a random Wednesday, which a flat
  // per-goal list would otherwise do regardless of today's date).
  function renderAllTimeGoals() {
    allTimeList.textContent = "";
    const history = getGoalHistory();

    if (history.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No history yet";
      allTimeList.appendChild(empty);
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
    allTimeList.appendChild(completedRow);

    const skippedRow = document.createElement("div");
    skippedRow.className = "dashboard-row";
    skippedRow.textContent = mostSkipped
      ? `Most skipped: ${mostSkipped.label} (${mostSkipped.count}×)`
      : "Most skipped: —";
    allTimeList.appendChild(skippedRow);
  }

  return {
    open() {
      panel.open();
      renderTodayActivity();
      renderAllTimeActivity();
      renderTodayGoals();
      renderAllTimeGoals();
    },
  };
}
