import { getDurationMinutes } from "../aw/client";
import { createJsonFileStore } from "../lib/jsonFileStore";
import { createPersistedState } from "../lib/persistedState";
import { addDaysToDateString, isScheduledOn, parseDateString } from "./recurrence";
import { getGoals, todayDateString } from "./state";
import { Goal } from "./types";

export interface GoalHistoryEntry {
  goalId: string;
  date: string; // "YYYY-MM-DD" — the day this outcome applies to, always a past (settled) day, never today
  activityLabel: string;
  targetMinutes: number;
  actualMinutes: number;
  outcome: "completed" | "skipped" | "missed";
}

const goalHistoryFileStore = createJsonFileStore<GoalHistoryEntry[]>("goalHistory.json", []);
const goalHistoryState = createPersistedState(goalHistoryFileStore.load, goalHistoryFileStore.save);

export const initGoalHistoryState = goalHistoryState.init;
export const getGoalHistory = goalHistoryState.get;
export const onGoalHistoryChange = goalHistoryState.onChange;

export function historyForGoal(goalId: string): GoalHistoryEntry[] {
  return getGoalHistory().filter((h) => h.goalId === goalId);
}

function lastSettledDateFor(goalId: string, history: GoalHistoryEntry[]): string | null {
  const dates = history.filter((h) => h.goalId === goalId).map((h) => h.date);
  return dates.length ? dates.reduce((max, d) => (d > max ? d : max)) : null;
}

async function settleGoal(goal: Goal, todayStr: string, history: GoalHistoryEntry[]): Promise<GoalHistoryEntry[]> {
  // No reliable starting point for a goal that predates this field — rather
  // than guess, it simply gets no history before whichever day it's first
  // seen with createdAt set (i.e. none, retroactively).
  if (!goal.createdAt) return [];

  const lastSettled = lastSettledDateFor(goal.id, history);
  const entries: GoalHistoryEntry[] = [];

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
        actualMinutes = await getDurationMinutes(goal.activityLabel, {
          start: cursorDate,
          end: parseDateString(addDaysToDateString(cursor, 1)),
        });
        outcome = actualMinutes >= goal.targetMinutes ? "completed" : "missed";
      }
      entries.push({
        goalId: goal.id,
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

/**
 * Records a completed/skipped/missed outcome for every scheduled day between
 * each goal's last-settled date (or its creation date) and yesterday — never
 * today, which stays live/derived like the rest of the goals UI. Goal
 * definitions are editable, so a day's outcome can't be correctly
 * re-derived after the fact once a goal's target/schedule has changed —
 * this is why it's an append-only log instead of being recomputed on
 * demand the way "is this done today" is.
 */
export async function settleGoalHistory(): Promise<void> {
  const todayStr = todayDateString();
  const history = getGoalHistory();

  const newEntries: GoalHistoryEntry[] = [];
  for (const goal of getGoals()) {
    newEntries.push(...(await settleGoal(goal, todayStr, history)));
  }

  if (newEntries.length > 0) {
    await goalHistoryState.persist([...history, ...newEntries]);
  }
}
