import { sendQuery } from "../client/remoteState";
import { WorkoutSession, WgerLifetimeStats, PersonalRecord, DaySummary } from "./types";

/**
 * Thin RPC wrapper around the "getWorkoutsForDate" query (server/rpc.ts) —
 * same shape and same `viewingCharacterId` convention every other
 * date-scoped Dashboard query already uses (see dashboard/panel.ts's
 * getGoalProgressForDate/getActivityStatsForDate), so the Workout modal and
 * the Dashboard's "Lifted Today" section can both call this one function
 * instead of each hand-rolling their own sendQuery call.
 */
export async function fetchWorkoutsForDate(dateStr: string, viewingCharacterId?: string): Promise<WorkoutSession[]> {
  return sendQuery<WorkoutSession[]>("getWorkoutsForDate", { dateStr, viewingCharacterId });
}

/** Same thin-wrapper pattern as fetchWorkoutsForDate above, for the Statistic modal's Workout tab (Lifetime Stats/Personal Records/Logs) — all three are wger-only (null/empty for a non-wger-linked character, see server/workouts.ts), not date-scoped. */
export async function fetchWgerLifetimeStats(viewingCharacterId?: string): Promise<WgerLifetimeStats | null> {
  return sendQuery<WgerLifetimeStats | null>("getWgerLifetimeStats", { viewingCharacterId });
}

export async function fetchWgerPersonalRecords(viewingCharacterId?: string): Promise<PersonalRecord[]> {
  return sendQuery<PersonalRecord[]>("getWgerPersonalRecords", { viewingCharacterId });
}

export async function fetchWgerRecentDaySummaries(viewingCharacterId?: string): Promise<DaySummary[]> {
  return sendQuery<DaySummary[]>("getWgerRecentDaySummaries", { viewingCharacterId });
}
