import { db } from "./db";
import { WorkoutSession, WorkoutSet } from "../src/workout/types";
import { getWgerWorkoutsForDate, isWgerLinkedCharacter } from "./wger";

export type { WorkoutSession, WorkoutSet };

interface SessionRow {
  id: string;
  date: string;
  notes: string | null;
}

interface SetRow {
  id: string;
  exercise_name: string;
  weight: number | null;
  weight_unit: string | null;
  reps: number;
  set_order: number;
}

/** The original mock mirror — read-only SQLite shape mirroring wger's Session/Log split (see wger_gamification_implementation_plan.md). Still the fallback for any character NOT linked to the one configured real wger account (see getWorkoutsForDate below) — e.g. a demo install with no wger credentials set, or a second character with no wger account of their own. */
function getMockWorkoutsForDate(characterId: string, dateStr: string): WorkoutSession[] {
  const sessionRows = db
    .prepare("SELECT id, date, notes FROM workout_sessions WHERE character_id = ? AND date = ? ORDER BY date")
    .all(characterId, dateStr) as SessionRow[];

  return sessionRows.map((row) => {
    const setRows = db
      .prepare("SELECT id, exercise_name, weight, weight_unit, reps, set_order FROM workout_sets WHERE session_id = ? ORDER BY set_order")
      .all(row.id) as SetRow[];
    return {
      id: row.id,
      date: row.date,
      notes: row.notes,
      sets: setRows.map((s) => ({
        id: s.id,
        exerciseName: s.exercise_name,
        weight: s.weight,
        weightUnit: s.weight_unit,
        reps: s.reps,
        setOrder: s.set_order,
      })),
    };
  });
}

/**
 * Real wger data replaces the mock mirror, per-character: whichever
 * character resolveWgerCharacterId() (server/wger.ts) says the one
 * configured wger account belongs to gets live data from wger itself;
 * every other character (or every character, if wger isn't configured at
 * all) keeps reading the mock mirror. Same query name/shape either way —
 * src/workout/modal.ts and the Dashboard's "Lifted Today" section
 * (dashboard/panel.ts) never need to know which backend answered.
 *
 * This is the "layer underneath" choice CLAUDE.md's wger section documents
 * the reasoning for: the mock mirror isn't deleted, since it's still a
 * reasonable zero-config demo/fallback experience, but it's no longer the
 * only thing this query can return.
 */
export async function getWorkoutsForDate(characterId: string, dateStr: string): Promise<WorkoutSession[]> {
  if (isWgerLinkedCharacter(characterId)) {
    try {
      return await getWgerWorkoutsForDate(dateStr);
    } catch (err) {
      console.error("[workouts] wger fetch failed, falling back to no data for this call", err);
      return [];
    }
  }
  return getMockWorkoutsForDate(characterId, dateStr);
}

/**
 * Mock stand-in for a real wger account, for whichever character ISN'T
 * wger-linked (see getWorkoutsForDate above) — originally the only data
 * source this file had, back before a real wger instance was reachable.
 * Still seeded at server startup (server/index.ts), but only when
 * resolveWgerCharacterId() doesn't resolve to the character being seeded
 * — once real credentials are configured for Jacqueline, this stops being
 * written for her and the real client (server/wger.ts) takes over the
 * exact same query surface instead. weight_unit is never set here (stays
 * null) since the mock data always implied kg — formatSetDetail()
 * (src/workout/format.ts) defaults a null unit to "kg" for exactly this
 * reason.
 */
export function seedMockWorkoutsIfEmpty(characterId: string, dateStr: string): void {
  const existing = db.prepare("SELECT 1 FROM workout_sessions WHERE character_id = ? AND date = ?").get(characterId, dateStr);
  if (existing) return;

  const sessionId = crypto.randomUUID();
  db.prepare("INSERT INTO workout_sessions (id, character_id, date, notes) VALUES (?, ?, ?, ?)").run(
    sessionId,
    characterId,
    dateStr,
    "Mock data — seeded for testing, not from a real wger server.",
  );

  const sets: { exerciseName: string; weight: number | null; reps: number }[] = [
    { exerciseName: "Deadlift", weight: 100, reps: 5 },
    { exerciseName: "Deadlift", weight: 100, reps: 5 },
    { exerciseName: "Deadlift", weight: 100, reps: 5 },
    { exerciseName: "Bench Press", weight: 60, reps: 8 },
    { exerciseName: "Bench Press", weight: 60, reps: 8 },
    { exerciseName: "Bench Press", weight: 60, reps: 7 },
    { exerciseName: "Pull-up", weight: null, reps: 10 },
    { exerciseName: "Pull-up", weight: null, reps: 8 },
  ];
  const insert = db.prepare(
    "INSERT INTO workout_sets (id, session_id, exercise_name, weight, reps, set_order) VALUES (?, ?, ?, ?, ?, ?)",
  );
  sets.forEach((s, i) => insert.run(crypto.randomUUID(), sessionId, s.exerciseName, s.weight, s.reps, i));
}
