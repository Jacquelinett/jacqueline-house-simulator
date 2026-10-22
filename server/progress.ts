import { getDurationMinutes, getTodayDurationMinutes } from "../src/aw/client";
import { groupGoalsForDate } from "../src/goals/goalGroups";
import { addDaysToDateString, localDateString, parseDateString } from "../src/goals/recurrence";
import { Goal } from "../src/goals/types";
import { ACTIVITIES } from "../src/scene/activities";
import { getGoals } from "./goals";
import { getCharacterById } from "./characters";

/** Server-side home for src/goals/progress.ts's logic — identical except getGoals comes from ./goals (SQLite-backed, now character-scoped) instead of the client's Tauri-fs ./state. See server/goals.ts's header comment for why this is a deliberate, temporary duplicate. */
export interface GoalProgress {
  activityLabel: string;
  targetMinutes: number;
  minutes: number;
  done: boolean;
  goals: Goal[];
}

function bucketIdFor(characterId: string): string {
  const bucketId = getCharacterById(characterId)?.awBucketId;
  if (!bucketId) throw new Error(`unknown character: ${characterId}`);
  return bucketId;
}

export async function getGoalProgressForDate(characterId: string, dateStr: string): Promise<GoalProgress[]> {
  const bucketId = bucketIdFor(characterId);
  const date = parseDateString(dateStr);
  const isToday = dateStr === localDateString(new Date());
  return Promise.all(
    groupGoalsForDate(getGoals(characterId), date).map(async ({ activityLabel, targetMinutes, goals }) => {
      const minutes = await (isToday
        ? getTodayDurationMinutes(bucketId, activityLabel)
        : getDurationMinutes(bucketId, activityLabel, { start: date, end: parseDateString(addDaysToDateString(dateStr, 1)) })
      ).catch(() => 0);
      return { activityLabel, targetMinutes, minutes, done: minutes >= targetMinutes, goals };
    }),
  );
}

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

export async function getGoalProgressForRange(characterId: string, start: Date, endExclusive: Date): Promise<RangeGoalProgress[]> {
  const bucketId = bucketIdFor(characterId);
  const targets = sumGoalTargetsForRange(getGoals(characterId), start, endExclusive);
  return Promise.all(
    Object.entries(targets).map(async ([activityLabel, targetMinutes]) => {
      const minutes = await getDurationMinutes(bucketId, activityLabel, { start, end: endExclusive }).catch(() => 0);
      return { activityLabel, targetMinutes, minutes, done: minutes >= targetMinutes };
    }),
  );
}

export async function getTodayMinutesByLabel(characterId: string): Promise<Record<string, number>> {
  const bucketId = bucketIdFor(characterId);
  const result: Record<string, number> = {};
  for (const activity of Object.values(ACTIVITIES)) {
    result[activity.label] = await getTodayDurationMinutes(bucketId, activity.label, { excludeRunning: true }).catch(() => 0);
  }
  return result;
}
