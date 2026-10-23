import { WorkoutSession, WorkoutSet, WgerLifetimeStats, PersonalRecord, RecentSession, DaySummary } from "../src/workout/types";
import { getWgerWorkoutsForDate, getWgerLifetimeStats, getWgerPersonalRecords, getWgerRecentSessions, getWgerRecentDaySummaries, isWgerLinkedCharacter } from "./wger";

export type { WorkoutSession, WorkoutSet, WgerLifetimeStats, PersonalRecord, RecentSession, DaySummary };

/**
 * One wger account backs this whole feature (see server/wger.ts's own
 * header comment on why it's inherently single-account) — whichever
 * character resolveWgerCharacterId() says that account belongs to gets
 * real logged data; every other character (no wger account of their own,
 * or wger not configured at all) gets an empty array, not placeholder
 * data. This used to fall back to a hand-seeded mock SQLite mirror (kept
 * around as a "zero-config demo" before a real wger instance was
 * reachable) — removed outright once real data replaced it everywhere
 * that mattered, since showing fake workout data to anyone not actually
 * wger-linked was never the goal, it was just a stand-in for not having
 * this built yet.
 */
export async function getWorkoutsForDate(characterId: string, dateStr: string): Promise<WorkoutSession[]> {
  if (!isWgerLinkedCharacter(characterId)) return [];
  try {
    return await getWgerWorkoutsForDate(dateStr);
  } catch (err) {
    console.error("[workouts] wger fetch failed, falling back to no data for this call", err);
    return [];
  }
}

/** Same per-character gatekeeping as getWorkoutsForDate above — null (not an error) for anyone not wger-linked. */
export async function getLifetimeStatsForCharacter(characterId: string): Promise<WgerLifetimeStats | null> {
  if (!isWgerLinkedCharacter(characterId)) return null;
  try {
    return await getWgerLifetimeStats();
  } catch (err) {
    console.error("[workouts] wger lifetime-stats fetch failed", err);
    return null;
  }
}

/** Same per-character gatekeeping as getWorkoutsForDate above. */
export async function getPersonalRecordsForCharacter(characterId: string): Promise<PersonalRecord[]> {
  if (!isWgerLinkedCharacter(characterId)) return [];
  try {
    return await getWgerPersonalRecords();
  } catch (err) {
    console.error("[workouts] wger personal-records fetch failed", err);
    return [];
  }
}

/** Same per-character gatekeeping as getWorkoutsForDate above. */
export async function getRecentSessionsForCharacter(characterId: string): Promise<RecentSession[]> {
  if (!isWgerLinkedCharacter(characterId)) return [];
  try {
    return await getWgerRecentSessions();
  } catch (err) {
    console.error("[workouts] wger recent-sessions fetch failed", err);
    return [];
  }
}

/** Same per-character gatekeeping as getWorkoutsForDate above — the public-facing (no exact times/notes) equivalent of getRecentSessionsForCharacter, see DaySummary's own comment. */
export async function getRecentDaySummariesForCharacter(characterId: string): Promise<DaySummary[]> {
  if (!isWgerLinkedCharacter(characterId)) return [];
  try {
    return await getWgerRecentDaySummaries();
  } catch (err) {
    console.error("[workouts] wger recent-day-summaries fetch failed", err);
    return [];
  }
}
