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
export async function getTodayGoalProgress(): Promise<GoalProgress[]> {
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

  const progress: GoalProgress[] = [];
  for (const [activityLabel, group] of groups) {
    const minutes = await getTodayDurationMinutes(activityLabel).catch(() => 0);
    const targetMinutes = group.reduce((sum, g) => sum + g.targetMinutes, 0);
    progress.push({ activityLabel, targetMinutes, minutes, done: minutes >= targetMinutes });
  }
  return progress;
}
