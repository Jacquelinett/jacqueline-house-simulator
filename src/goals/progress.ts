import { getDurationMinutes, getTodayDurationMinutes } from "../aw/client";
import { getGoals } from "./state";
import { groupGoalsForDate } from "./goalGroups";
import { addDaysToDateString, localDateString, parseDateString } from "./recurrence";
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

/**
 * Goal progress for a single day. For the real current day, minutes come
 * from `getTodayDurationMinutes` (live, up to "now"); for any other day
 * (the Dashboard date picker looking at a past/future day) minutes come
 * from a plain midnight-to-midnight range query instead, since "now" isn't
 * meaningful for a day that isn't today.
 */
export async function getGoalProgressForDate(dateStr: string): Promise<GoalProgress[]> {
  const date = parseDateString(dateStr);
  const isToday = dateStr === localDateString(new Date());
  return Promise.all(
    groupGoalsForDate(getGoals(), date).map(async ({ activityLabel, targetMinutes, goals }) => {
      const minutes = await (isToday
        ? getTodayDurationMinutes(activityLabel)
        : getDurationMinutes(activityLabel, { start: date, end: parseDateString(addDaysToDateString(dateStr, 1)) })
      ).catch(() => 0);
      return { activityLabel, targetMinutes, minutes, done: minutes >= targetMinutes, goals };
    }),
  );
}

/**
 * Sums each scheduled goal's target across every day in [start, end) by
 * activity label — the range equivalent of `groupGoalsForDate`'s per-day
 * grouping, walked one day at a time since a goal's schedule can vary
 * day-to-day within the range (e.g. a weekly goal only hits some days).
 */
function sumGoalTargetsForRange(goals: Goal[], start: Date, endExclusive: Date): Record<string, number> {
  const totals: Record<string, number> = {};
  const cursor = new Date(start);
  while (cursor < endExclusive) {
    for (const group of groupGoalsForDate(goals, cursor)) {
      totals[group.activityLabel] = (totals[group.activityLabel] ?? 0) + group.targetMinutes;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return totals;
}

export interface RangeGoalProgress {
  activityLabel: string;
  targetMinutes: number;
  minutes: number;
  done: boolean;
}

/**
 * Goal progress aggregated over [start, end) — Statistic's Period tab (a
 * week or a month at a time). Unlike `getGoalProgressForDate`, this has no
 * per-goal `goals` list to report: a multi-day aggregate doesn't map back
 * to "which specific goal contributed" the way a single day's grouping
 * does, and nothing renders a sub-row breakdown for a period view anyway.
 */
export async function getGoalProgressForRange(start: Date, endExclusive: Date): Promise<RangeGoalProgress[]> {
  const targets = sumGoalTargetsForRange(getGoals(), start, endExclusive);
  return Promise.all(
    Object.entries(targets).map(async ([activityLabel, targetMinutes]) => {
      const minutes = await getDurationMinutes(activityLabel, { start, end: endExclusive }).catch(() => 0);
      return { activityLabel, targetMinutes, minutes, done: minutes >= targetMinutes };
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
