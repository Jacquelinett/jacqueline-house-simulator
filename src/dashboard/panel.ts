import { buildFloatingPanel } from "../ui/draggablePanel";
import { getTodayActivityStats } from "./stats";
import { formatMinutes, describeRecurrence } from "../goals/ui";
import { toCssColor } from "../scene/activities";
import { getTodayGoalProgress } from "../goals/progress";
import { getGoals, onGoalsChange, todayDateString } from "../goals/state";
import { isScheduledOn } from "../goals/recurrence";
import { Recurrence } from "../goals/types";

const REFRESH_INTERVAL_MS = 30_000;

// This panel only ever shows goals scheduled for today, so a one-off goal's
// literal date is always just... today — showing it plainly is clearer than
// the generic "once (2026-10-21)" phrasing describeRecurrence() uses
// elsewhere (e.g. the manage modal, where goals for OTHER days are visible
// too and the real date still matters there).
function describeScheduleForToday(recurrence: Recurrence): string {
  return recurrence.type === "once" ? "Today" : describeRecurrence(recurrence);
}

/** Always-visible today-only panel (goals progress + activity breakdown) — all-time standouts live in the separate Statistic modal instead, to avoid overlapping with the same info. */
export function setupDashboardPanel(): void {
  const panel = buildFloatingPanel("Dashboard", { closable: false, className: "dashboard-panel" });

  const goalHeading = document.createElement("h3");
  goalHeading.className = "panel-section-heading";
  goalHeading.textContent = "Today's Goals";
  panel.body.appendChild(goalHeading);

  const goalList = document.createElement("div");
  goalList.id = "dashboard-today-goals-list";
  panel.body.appendChild(goalList);

  const divider = document.createElement("div");
  divider.className = "panel-divider";
  panel.body.appendChild(divider);

  const activityHeading = document.createElement("h3");
  activityHeading.className = "panel-section-heading";
  activityHeading.textContent = "Today's Activity";
  panel.body.appendChild(activityHeading);

  const activityList = document.createElement("div");
  activityList.id = "dashboard-today-activity-list";
  panel.body.appendChild(activityList);

  async function renderGoals() {
    goalList.textContent = "";
    const progress = await getTodayGoalProgress();

    if (progress.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No goals today";
      goalList.appendChild(empty);
      return;
    }

    const today = new Date();
    const todayStr = todayDateString();

    for (const { activityLabel, minutes, targetMinutes, done } of progress) {
      const row = document.createElement("div");
      row.className = "goal-row" + (done ? " goal-done" : "");

      const check = document.createElement("span");
      check.className = "goal-check";
      check.textContent = done ? "☑" : "☐";
      row.appendChild(check);

      const text = document.createElement("span");
      text.className = "goal-text";
      text.textContent = `${activityLabel} — ${formatMinutes(minutes)} / ${formatMinutes(targetMinutes)}`;
      row.appendChild(text);

      goalList.appendChild(row);

      const contributing = getGoals().filter(
        (g) =>
          g.activityLabel === activityLabel &&
          isScheduledOn(g.recurrence, today) &&
          !g.skipDates?.includes(todayStr),
      );
      for (const goal of contributing) {
        const subRow = document.createElement("div");
        subRow.className = "goal-subrow";

        const subText = document.createElement("span");
        subText.className = "goal-subtext";
        subText.textContent = `${describeScheduleForToday(goal.recurrence)} — ${formatMinutes(goal.targetMinutes)}`;
        subRow.appendChild(subText);

        goalList.appendChild(subRow);
      }
    }
  }

  async function renderActivity() {
    activityList.textContent = "";
    const stats = await getTodayActivityStats().catch((err) => {
      console.error("[dashboard] failed to load today's activity", err);
      return null;
    });

    if (!stats) {
      const error = document.createElement("div");
      error.className = "goals-empty";
      error.textContent = "Failed to load";
      activityList.appendChild(error);
      return;
    }

    if (stats.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "Nothing tracked today";
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
      text.textContent = `${s.label} — ${formatMinutes(s.minutes)}`;
      row.appendChild(text);

      activityList.appendChild(row);
    }
  }

  onGoalsChange(renderGoals);
  renderGoals();
  setInterval(renderGoals, REFRESH_INTERVAL_MS);

  renderActivity();
  setInterval(renderActivity, REFRESH_INTERVAL_MS);

  panel.open();
}
