import { WorkoutSession, WorkoutSet } from "../src/workout/types";
import { getWgerWorkoutsForDate, isWgerLinkedCharacter } from "./wger";

export type { WorkoutSession, WorkoutSet };

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
