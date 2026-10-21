import { getTodayDurationMinutes } from "../aw/client";
import { isScheduledOn } from "./recurrence";
import { getGoals, onGoalsChange, todayDateString } from "./state";
import { formatMinutes, describeRecurrence } from "./ui";
import { Goal } from "./types";

const REFRESH_INTERVAL_MS = 30_000;

/** Read-only view of today's goals and progress — all editing lives in the manage modal (opened from the top-right "Goals" button). */
export async function setupGoalsPanel(): Promise<void> {
  const panel = document.createElement("div");
  panel.id = "goals-panel";
  document.body.appendChild(panel);

  const list = document.createElement("div");
  list.id = "goals-list";
  panel.appendChild(list);

  async function render() {
    const today = new Date();
    const todayStr = todayDateString();
    const scheduled = getGoals().filter(
      (g) => isScheduledOn(g.recurrence, today) && !g.skipDates?.includes(todayStr),
    );

    // AW only measures total time per activity label, not per goal — two
    // goals for the same activity on the same day (e.g. a daily recurring
    // goal plus a one-off "extra today") can't be counted separately, so
    // they're summed into a single progress check instead of double-counting
    // the same practice time against two independent targets.
    const groups = new Map<string, Goal[]>();
    for (const goal of scheduled) {
      const group = groups.get(goal.activityLabel);
      if (group) group.push(goal);
      else groups.set(goal.activityLabel, [goal]);
    }

    list.textContent = "";
    if (groups.size === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No goals today";
      list.appendChild(empty);
    }

    for (const [activityLabel, group] of groups) {
      const minutes = await getTodayDurationMinutes(activityLabel).catch(() => 0);
      const targetMinutes = group.reduce((sum, g) => sum + g.targetMinutes, 0);
      const done = minutes >= targetMinutes;

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

      list.appendChild(row);

      for (const goal of group) {
        const subRow = document.createElement("div");
        subRow.className = "goal-subrow";

        const subText = document.createElement("span");
        subText.className = "goal-subtext";
        subText.textContent = `${describeRecurrence(goal.recurrence)} — ${formatMinutes(goal.targetMinutes)}`;
        subRow.appendChild(subText);

        list.appendChild(subRow);
      }
    }
  }

  onGoalsChange(render);
  await render();
  setInterval(render, REFRESH_INTERVAL_MS);
}
