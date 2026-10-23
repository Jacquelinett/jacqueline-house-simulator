import { sendQuery } from "../client/remoteState";
import { WorkoutSession } from "./types";

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
