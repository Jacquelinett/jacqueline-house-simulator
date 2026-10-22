import { formatStreak } from "./format";
import { Goal, GoalHistoryEntry } from "./types";
import { sendQuery } from "../client/remoteState";

/**
 * Settlement (the day-by-day AW-querying walk, streak bookkeeping) moved
 * server-side entirely (server/goalHistory.ts) — it runs on its own
 * schedule there regardless of whether any client is connected. This file
 * now only has the pure aggregation/formatting helpers (identical to the
 * server's copies — they take whatever history array they're handed, so
 * there's nothing server-specific about them) plus thin query wrappers
 * for fetching that array, since the full log no longer lives locally.
 */
export function historyForGoal(goalId: string): Promise<GoalHistoryEntry[]> {
  return sendQuery<GoalHistoryEntry[]>("historyForGoal", { goalId });
}

/**
 * The full log — mainly for the Statistic modal's All-Time tab, which
 * genuinely needs every goal's history; everything else should prefer
 * historyForGoal(). Also used by dashboard/panel.ts for streak text when
 * peeking at another character's dashboard, hence the optional
 * `viewingCharacterId` override (see that file's own comment).
 */
export function getGoalHistory(viewingCharacterId?: string): Promise<GoalHistoryEntry[]> {
  return sendQuery<GoalHistoryEntry[]>("getGoalHistory", { viewingCharacterId });
}

export interface GoalHistorySummary {
  mostCompleted: { label: string; count: number } | null;
  mostSkipped: { label: string; count: number } | null;
}

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
