import { getDurationMinutes } from "../src/aw/client";
import { addDaysToDateString, isScheduledOn, parseDateString } from "../src/goals/recurrence";
import { formatStreak } from "../src/goals/format";
import { Goal, GoalHistoryEntry } from "../src/goals/types";
import { getAllGoals, getGoals, persistGoals, todayDateString } from "./goals";
import { getCharacterById } from "./characters";
import { goalHistoryStore } from "./stores/goalHistoryStore";

export function historyForGoal(characterId: string, goalId: string): GoalHistoryEntry[] {
  return goalHistoryStore.getForGoal(goalId).filter((h) => h.characterId === characterId);
}

/** The full log, scoped to one character — only for the Statistic modal's All-Time tab, which genuinely needs every goal's history to find the single most-completed/skipped activity overall. Everything else should prefer historyForGoal() or a date-range query. */
export function getAllHistory(characterId: string): GoalHistoryEntry[] {
  return goalHistoryStore.getAll(characterId);
}

export interface GoalHistorySummary {
  mostCompleted: { label: string; count: number } | null;
  mostSkipped: { label: string; count: number } | null;
}

/** Same aggregation as the client's version (goals/history.ts) — kept identical so it can be deleted and re-pointed at this module once the frontend is rewired, not reinvented. */
export function summarizeGoalHistory(history: GoalHistoryEntry[]): GoalHistorySummary {
  const byLabel = new Map<string, Record<GoalHistoryEntry["outcome"], number>>();
  for (const entry of history) {
    const counts = byLabel.get(entry.activityLabel) ?? { completed: 0, skipped: 0, missed: 0 };
    counts[entry.outcome]++;
    byLabel.set(entry.activityLabel, counts);
  }

  let mostCompleted: { label: string; count: number } | null = null;
  let mostSkipped: { label: string; count: number } | null = null;
  for (const [label, counts] of byLabel) {
    if (counts.completed > 0 && (!mostCompleted || counts.completed > mostCompleted.count)) {
      mostCompleted = { label, count: counts.completed };
    }
    if (counts.skipped > 0 && (!mostSkipped || counts.skipped > mostSkipped.count)) {
      mostSkipped = { label, count: counts.skipped };
    }
  }

  return { mostCompleted, mostSkipped };
}

export function getCurrentStreakLength(goal: Goal, history: GoalHistoryEntry[]): number {
  if (goal.recurrence.type === "once" || !goal.streakStartDate) return 0;
  return history.filter((h) => h.goalId === goal.id && h.outcome === "completed" && h.date >= goal.streakStartDate!).length;
}

export function describeStreak(goal: Goal, history: GoalHistoryEntry[]): string | null {
  return formatStreak(getCurrentStreakLength(goal, history), goal.highestStreak ?? 0);
}

export function getTodayStreaksByGoalId(characterId: string): Record<string, number> {
  const today = new Date();
  const result: Record<string, number> = {};
  for (const goal of getGoals(characterId)) {
    if (goal.recurrence.type === "once" || !isScheduledOn(goal.recurrence, today)) continue;
    result[goal.id] = getCurrentStreakLength(goal, historyForGoal(characterId, goal.id));
  }
  return result;
}

function updateStreak(goal: Goal, historySoFar: GoalHistoryEntry[], cursor: string, outcome: GoalHistoryEntry["outcome"]): void {
  if (goal.recurrence.type === "once") return;

  if (outcome === "completed") {
    const previousLength = getCurrentStreakLength(goal, historySoFar);
    if (previousLength === 0) goal.streakStartDate = cursor;
    goal.highestStreak = Math.max(goal.highestStreak ?? 0, previousLength + 1);
  } else {
    goal.streakStartDate = cursor;
  }
}

async function settleGoal(goal: Goal, bucketId: string, todayStr: string): Promise<GoalHistoryEntry[]> {
  if (!goal.createdAt) return [];

  const lastSettled = goalHistoryStore.lastSettledDateFor(goal.id);
  const entries: GoalHistoryEntry[] = [];
  const existingHistory = goalHistoryStore.getForGoal(goal.id);

  let cursor = lastSettled ? addDaysToDateString(lastSettled, 1) : goal.createdAt;
  while (cursor < todayStr) {
    const cursorDate = parseDateString(cursor);
    if (isScheduledOn(goal.recurrence, cursorDate)) {
      const skipped = goal.skipDates?.includes(cursor) ?? false;
      let actualMinutes = 0;
      let outcome: GoalHistoryEntry["outcome"];
      if (skipped) {
        outcome = "skipped";
      } else {
        actualMinutes = await getDurationMinutes(bucketId, goal.activityLabel, {
          start: cursorDate,
          end: parseDateString(addDaysToDateString(cursor, 1)),
        });
        outcome = actualMinutes >= goal.targetMinutes ? "completed" : "missed";
      }
      updateStreak(goal, [...existingHistory, ...entries], cursor, outcome);
      entries.push({
        goalId: goal.id,
        characterId: goal.characterId,
        date: cursor,
        activityLabel: goal.activityLabel,
        targetMinutes: goal.targetMinutes,
        actualMinutes,
        outcome,
      });
    }
    cursor = addDaysToDateString(cursor, 1);
  }

  return entries;
}

/** Same contract as the client's settleGoalHistory() — backfills every scheduled day since each goal's last settle (or creation) up to yesterday, and updates streak fields in place. Runs on server startup + the hourly scheduler (server/index.ts) instead of once on Tauri app launch, so it keeps happening even with no client connected. Iterates every character's goals (getAllGoals(), not the per-connection getGoals()) since this is a global background job, not something triggered by any one connection. */
export async function settleGoalHistory(): Promise<void> {
  const todayStr = todayDateString();

  const newEntries: GoalHistoryEntry[] = [];
  let goalsChanged = false;
  for (const goal of getAllGoals()) {
    const bucketId = getCharacterById(goal.characterId)?.awBucketId;
    if (!bucketId) continue; // character was deleted but a goal still references it — skip rather than throw

    const beforeStreakStart = goal.streakStartDate;
    const beforeHighest = goal.highestStreak;
    newEntries.push(...(await settleGoal(goal, bucketId, todayStr)));
    if (goal.streakStartDate !== beforeStreakStart || goal.highestStreak !== beforeHighest) goalsChanged = true;
  }

  if (newEntries.length > 0) {
    goalHistoryStore.insertMany(newEntries);
  }
  if (goalsChanged) {
    await persistGoals();
  }
}
