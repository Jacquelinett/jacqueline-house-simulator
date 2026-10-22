import { getDurationMinutes } from "../aw/client";
import { createJsonFileStore } from "../lib/jsonFileStore";
import { createPersistedState } from "../lib/persistedState";
import { addDaysToDateString, isScheduledOn, parseDateString } from "./recurrence";
import { getGoals, persistGoals, todayDateString } from "./state";
import { formatStreak } from "./format";
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

export interface GoalHistorySummary {
  mostCompleted: { label: string; count: number } | null;
  mostSkipped: { label: string; count: number } | null;
}

/**
 * Most completed/most skipped activity across whatever slice of history is
 * passed in — aggregated by activity label, not per-goal (a recurring
 * goal's own history is about the activity overall, not whichever specific
 * schedule happens to track it). Shared by the Statistic modal's All-Time
 * tab (the full history) and its Period tab (history filtered to a week or
 * month first) — the only difference between those two callers is which
 * slice of `getGoalHistory()` they pass in.
 */
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

function lastSettledDateFor(goalId: string, history: GoalHistoryEntry[]): string | null {
  const dates = history.filter((h) => h.goalId === goalId).map((h) => h.date);
  return dates.length ? dates.reduce((max, d) => (d > max ? d : max)) : null;
}

/**
 * Current streak length for a recurring goal, derived from its stored
 * `streakStartDate` anchor rather than re-walked from scratch — just a
 * count of this goal's `completed` entries on or after that date. This is
 * correct even on the day right after a loss (when `streakStartDate` has
 * just been re-anchored to that loss day, which itself wasn't completed):
 * the count naturally comes out to 0 until the next real completion,
 * without needing a separate "is there currently a streak at all" flag.
 * Returns 0 for a "once" goal (no repetition to streak) or a goal with no
 * streak data yet.
 */
export function getCurrentStreakLength(goal: Goal, history: GoalHistoryEntry[]): number {
  if (goal.recurrence.type === "once" || !goal.streakStartDate) return 0;
  return history.filter((h) => h.goalId === goal.id && h.outcome === "completed" && h.date >= goal.streakStartDate!).length;
}

/** "Streak: 3 (best 7)" for a recurring goal with any streak history, else null (nothing worth showing yet, or not a recurring goal). */
export function describeStreak(goal: Goal, history: GoalHistoryEntry[]): string | null {
  return formatStreak(getCurrentStreakLength(goal, history), goal.highestStreak ?? 0);
}

/**
 * Current streak length for every goal scheduled *today*, keyed by goal
 * id — what gets pushed to val.town (see broadcast/client.ts's
 * pushTodayStreaks) so the viewer's Dashboard can show a current streak
 * next to each of today's goals without needing the full history log
 * (which never leaves the desktop app). Only covers today's scheduled
 * goals, same scope as what the viewer's Dashboard actually shows goal
 * schedules for.
 */
export function getTodayStreaksByGoalId(): Record<string, number> {
  const today = new Date();
  const history = getGoalHistory();
  const result: Record<string, number> = {};
  for (const goal of getGoals()) {
    if (goal.recurrence.type === "once" || !isScheduledOn(goal.recurrence, today)) continue;
    result[goal.id] = getCurrentStreakLength(goal, history);
  }
  return result;
}

/**
 * Walks a single recurring goal's newly-scheduled days and updates its
 * streak fields in place as it goes (mutates `goal` directly, same
 * pattern `skipGoalToday`/`unskipGoalToday` use) — incremental, not
 * recomputed from the full history, so this stays cheap no matter how
 * long a goal's history gets. A "once" goal is skipped entirely: it has
 * exactly one scheduled day ever, nothing to streak.
 *
 * `streakStartDate` is re-anchored to *today* on every loss, not just left
 * unset — see `getCurrentStreakLength`'s comment for why a loss day being
 * the anchor still produces a correct (0) count.
 */
function updateStreak(goal: Goal, history: GoalHistoryEntry[], cursor: string, outcome: GoalHistoryEntry["outcome"]): void {
  if (goal.recurrence.type === "once") return;

  if (outcome === "completed") {
    // The streak-as-of-yesterday, read before today's entry exists in
    // `history` — today's completion either starts a new streak (if there
    // wasn't one) or extends the existing one by exactly 1, so there's no
    // need to re-derive the new length from history at all.
    const previousLength = getCurrentStreakLength(goal, history);
    if (previousLength === 0) goal.streakStartDate = cursor;
    goal.highestStreak = Math.max(goal.highestStreak ?? 0, previousLength + 1);
  } else {
    goal.streakStartDate = cursor;
  }
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
      updateStreak(goal, [...history, ...entries], cursor, outcome);
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
 *
 * Also updates each goal's streak fields in place as new days settle (see
 * updateStreak) — if any goal actually changed, the updated goals get
 * persisted alongside the new history entries, so streaks reach val.town
 * for free the next time goals are pushed (they're just more fields on
 * the same Goal objects).
 */
export async function settleGoalHistory(): Promise<void> {
  const todayStr = todayDateString();
  const history = getGoalHistory();

  const newEntries: GoalHistoryEntry[] = [];
  let goalsChanged = false;
  for (const goal of getGoals()) {
    const beforeStreakStart = goal.streakStartDate;
    const beforeHighest = goal.highestStreak;
    newEntries.push(...(await settleGoal(goal, todayStr, history)));
    if (goal.streakStartDate !== beforeStreakStart || goal.highestStreak !== beforeHighest) goalsChanged = true;
  }

  if (newEntries.length > 0) {
    await goalHistoryState.persist([...history, ...newEntries]);
  }
  if (goalsChanged) {
    await persistGoals();
  }
}
