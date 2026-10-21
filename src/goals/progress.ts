import { getTodayDurationMinutes } from "../aw/client";
import { isScheduledOn } from "./recurrence";
import { getGoals, todayDateString } from "./state";
import { Goal } from "./types";

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
 * Minutes tracked today per distinct activity label across every goal
 * (regardless of whether that goal is scheduled today — a remote viewer
 * gets the raw goal list separately and does its own scheduling/grouping,
 * so this only needs to answer "how much of X have I done today"). Excludes
 * whatever's currently running, since a remote viewer adds that session's
 * live elapsed time itself from `startedAt` — same as its "Running for X"
 * clock — instead of needing a fresh push just to avoid looking stale.
 */
export async function getTodayMinutesByLabel(): Promise<Record<string, number>> {
  const labels = new Set(getGoals().map((g) => g.activityLabel));
  const result: Record<string, number> = {};
  for (const label of labels) {
    result[label] = await getTodayDurationMinutes(label, { excludeRunning: true }).catch(() => 0);
  }
  return result;
}
