import { getTodayDurationMinutes } from "../aw/client";
import { isScheduledOn } from "./recurrence";
import { getGoals, todayDateString } from "./state";
import { Goal } from "./types";
import { ACTIVITIES } from "../scene/activities";

export interface GoalProgress {
  activityLabel: string;
  targetMinutes: number;
  minutes: number;
  done: boolean;
}

/**
 * Today's goals grouped by activity (AW only measures total time per label,
 * not per goal, so a daily recurring goal plus a one-off "extra today" for
 * the same activity get summed into one combined progress check rather than
 * double-counting the same practice time against two independent targets).
 */
function todaysGroupedGoals(): Map<string, Goal[]> {
  const today = new Date();
  const todayStr = todayDateString();
  const scheduled = getGoals().filter(
    (g) => isScheduledOn(g.recurrence, today) && !g.skipDates?.includes(todayStr),
  );

  const groups = new Map<string, Goal[]>();
  for (const goal of scheduled) {
    const group = groups.get(goal.activityLabel);
    if (group) group.push(goal);
    else groups.set(goal.activityLabel, [goal]);
  }
  return groups;
}

export async function getTodayGoalProgress(): Promise<GoalProgress[]> {
  const progress: GoalProgress[] = [];
  for (const [activityLabel, group] of todaysGroupedGoals()) {
    const minutes = await getTodayDurationMinutes(activityLabel).catch(() => 0);
    const targetMinutes = group.reduce((sum, g) => sum + g.targetMinutes, 0);
    progress.push({ activityLabel, targetMinutes, minutes, done: minutes >= targetMinutes });
  }
  return progress;
}

/**
 * Minutes tracked today per every known activity — not just ones with a
 * goal attached, since the viewer's own "Today Activity" breakdown needs
 * the same full list the desktop Dashboard shows, not just whatever
 * happens to have a goal right now. Excludes whatever's currently running,
 * since a remote viewer adds that session's live elapsed time itself from
 * `startedAt` — same as its "Running for X" clock — instead of needing a
 * fresh push just to avoid looking stale.
 */
export async function getTodayMinutesByLabel(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const activity of Object.values(ACTIVITIES)) {
    result[activity.label] = await getTodayDurationMinutes(activity.label, { excludeRunning: true }).catch(() => 0);
  }
  return result;
}
