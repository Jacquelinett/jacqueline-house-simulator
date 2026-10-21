import { getTodayDurationMinutes } from "../aw/client";
import { getGoals } from "./state";
import { groupTodaysGoals } from "./todayGroups";
import { Goal } from "./types";
import { ACTIVITIES } from "../scene/activities";

export interface GoalProgress {
  activityLabel: string;
  targetMinutes: number;
  minutes: number;
  done: boolean;
  // The specific goals contributing to this grouped total — callers that
  // render a sub-row per goal (schedule + target) need these; callers that
  // only care about the combined total can ignore it.
  goals: Goal[];
}

export async function getTodayGoalProgress(): Promise<GoalProgress[]> {
  return Promise.all(
    groupTodaysGoals(getGoals(), new Date()).map(async ({ activityLabel, targetMinutes, goals }) => {
      const minutes = await getTodayDurationMinutes(activityLabel).catch(() => 0);
      return { activityLabel, targetMinutes, minutes, done: minutes >= targetMinutes, goals };
    }),
  );
}

/**
 * Minutes tracked today per every known activity — not just ones with a
 * goal attached, since the viewer's own "Today's Activity" breakdown needs
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
