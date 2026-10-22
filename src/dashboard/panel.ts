import { buildFloatingPanel } from "../ui/draggablePanel";
import { getActivityStatsForDate } from "./stats";
import { getGoalProgressForDate } from "../goals/progress";
import { onGoalsChange } from "../goals/state";
import { describeScheduleForDate } from "../goals/goalGroups";
import { localDateString, parseDateString } from "../goals/recurrence";
import { formatMinutes } from "../goals/ui";
import { buildDashboardSections, renderActivityList, renderGoalList } from "./render";

const REFRESH_INTERVAL_MS = 30_000;

/** Today-only goals progress + activity breakdown — shared by the desktop/viewer Dashboard panel and the mobile Dashboard tab. All-time standouts live in the separate Statistic surface instead, to avoid overlapping with the same info. */
export function setupDashboardContent(container: HTMLElement): void {
  const dateRow = document.createElement("div");
  dateRow.className = "dashboard-date-row";
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.className = "dashboard-date-input";
  dateInput.value = localDateString(new Date());
  dateRow.appendChild(dateInput);
  container.appendChild(dateRow);

  const { goalHeading, goalList, activityHeading, activityList } = buildDashboardSections(container);

  function isViewingToday(): boolean {
    return dateInput.value === localDateString(new Date());
  }

  function updateHeadings() {
    if (isViewingToday()) {
      goalHeading.textContent = "Today's Goals";
      activityHeading.textContent = "Today's Activity";
      return;
    }
    const label = parseDateString(dateInput.value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    goalHeading.textContent = `${label}'s Goals`;
    activityHeading.textContent = `${label}'s Activity`;
  }

  async function renderGoals() {
    const progress = await getGoalProgressForDate(dateInput.value);
    renderGoalList(
      goalList,
      progress.map((p) => ({
        activityLabel: p.activityLabel,
        minutes: p.minutes,
        targetMinutes: p.targetMinutes,
        done: p.done,
        subRows: p.goals.map((g) => `${describeScheduleForDate(g.recurrence, dateInput.value)} — ${formatMinutes(g.targetMinutes)}`),
      })),
      isViewingToday() ? "No goals today" : "No goals that day",
    );
  }

  async function renderActivity() {
    const stats = await getActivityStatsForDate(dateInput.value).catch((err) => {
      console.error("[dashboard] failed to load activity for date", err);
      return null;
    });
    if (!stats) {
      renderActivityList(activityList, [], "Failed to load");
      return;
    }
    renderActivityList(activityList, stats, isViewingToday() ? "Nothing tracked today" : "Nothing tracked that day");
  }

  function renderAll() {
    updateHeadings();
    renderGoals();
    renderActivity();
  }

  dateInput.onchange = renderAll;
  onGoalsChange(renderGoals);
  renderAll();

  // A past/future day's data never changes once rendered — only keep
  // re-ticking on an interval while the picker is actually showing today,
  // same as the live-refresh behavior this had before the date picker.
  setInterval(() => {
    if (isViewingToday()) {
      renderGoals();
      renderActivity();
    }
  }, REFRESH_INTERVAL_MS);
}

/** Always-visible corner panel version of the above. */
export function setupDashboardPanel(): void {
  const panel = buildFloatingPanel("Dashboard", { closable: false, resizable: true, className: "dashboard-panel" });
  setupDashboardContent(panel.body);
  panel.open();
}
