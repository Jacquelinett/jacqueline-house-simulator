import { WorkoutSession, WorkoutSet, WgerLifetimeStats, PersonalRecord, DaySummary } from "../src/workout/types";
import { getWgerWorkoutsForDate, getWgerLifetimeStats, getWgerPersonalRecords, getWgerRecentDaySummaries } from "./wger";

export type { WorkoutSession, WorkoutSet, WgerLifetimeStats, PersonalRecord, DaySummary };

/**
 * Thin try/catch wrappers around server/wger.ts's own per-character
 * functions — each of those already resolves/gates on `characterId`'s own
 * linked wger account internally (null/empty for anyone without one, see
 * that file's own header comment on why this moved off a single global
 * server_config singleton), so there's nothing left to check here beyond
 * turning a network/API failure into "no data for this call" rather than
 * an unhandled rejection reaching the RPC layer.
 */
export async function getWorkoutsForDate(characterId: string, dateStr: string): Promise<WorkoutSession[]> {
  try {
    return await getWgerWorkoutsForDate(characterId, dateStr);
  } catch (err) {
    console.error("[workouts] wger fetch failed, falling back to no data for this call", err);
    return [];
  }
}

export async function getLifetimeStatsForCharacter(characterId: string): Promise<WgerLifetimeStats | null> {
  try {
    return await getWgerLifetimeStats(characterId);
  } catch (err) {
    console.error("[workouts] wger lifetime-stats fetch failed", err);
    return null;
  }
}

export async function getPersonalRecordsForCharacter(characterId: string): Promise<PersonalRecord[]> {
  try {
    return await getWgerPersonalRecords(characterId);
  } catch (err) {
    console.error("[workouts] wger personal-records fetch failed", err);
    return [];
  }
}

/** Same gatekeeping as the others above — feeds the Statistic modal's Workout > Logs section (desktop app, via RPC query) and the viewer's own equivalent (via pushWgerSummary), see DaySummary's own comment. */
export async function getRecentDaySummariesForCharacter(characterId: string): Promise<DaySummary[]> {
  try {
    return await getWgerRecentDaySummaries(characterId);
  } catch (err) {
    console.error("[workouts] wger recent-day-summaries fetch failed", err);
    return [];
  }
}
