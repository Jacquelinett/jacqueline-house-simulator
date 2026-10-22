import { buildFloatingPanel } from "../ui/draggablePanel";
import { getTodayActivityStats } from "./stats";
import { getTodayGoalProgress } from "../goals/progress";
import { onGoalsChange } from "../goals/state";
import { describeScheduleForToday } from "../goals/todayGroups";
import { formatMinutes } from "../goals/ui";
import { buildDashboardSections, renderActivityList, renderGoalList } from "./render";

const REFRESH_INTERVAL_MS = 30_000;

/** Today-only goals progress + activity breakdown — shared by the desktop/viewer Dashboard panel and the mobile Dashboard tab. All-time standouts live in the separate Statistic surface instead, to avoid overlapping with the same info. */
export function setupDashboardContent(container: HTMLElement): void {
  const { goalList, activityList } = buildDashboardSections(container);

  async function renderGoals() {
    const progress = await getTodayGoalProgress();
    renderGoalList(
      goalList,
      progress.map((p) => ({
        activityLabel: p.activityLabel,
        minutes: p.minutes,
        targetMinutes: p.targetMinutes,
        done: p.done,
        subRows: p.goals.map((g) => `${describeScheduleForToday(g.recurrence)} — ${formatMinutes(g.targetMinutes)}`),
      })),
    );
  }

  async function renderActivity() {
    const stats = await getTodayActivityStats().catch((err) => {
      console.error("[dashboard] failed to load today's activity", err);
      return null;
    });
    if (!stats) {
      renderActivityList(activityList, [], "Failed to load");
      return;
    }
    renderActivityList(activityList, stats, "Nothing tracked today");
  }

  onGoalsChange(renderGoals);
  renderGoals();
  setInterval(renderGoals, REFRESH_INTERVAL_MS);

  renderActivity();
  setInterval(renderActivity, REFRESH_INTERVAL_MS);
}

/** Always-visible corner panel version of the above. */
export function setupDashboardPanel(): void {
  const panel = buildFloatingPanel("Dashboard", { closable: false, className: "dashboard-panel" });
  setupDashboardContent(panel.body);
  panel.open();
}
