import { db } from "./db";

export interface WorkoutSet {
  id: string;
  exerciseName: string;
  weight: number | null;
  reps: number;
  setOrder: number;
}

export interface WorkoutSession {
  id: string;
  date: string;
  notes: string | null;
  sets: WorkoutSet[];
}

interface SessionRow {
  id: string;
  date: string;
  notes: string | null;
}

interface SetRow {
  id: string;
  exercise_name: string;
  weight: number | null;
  reps: number;
  set_order: number;
}

/** Read-only mirror of wger's Session/Log split (see wger_gamification_implementation_plan.md) — mirrors that shape now so swapping the mock seeder below for a real wger poller later is a data-source change, not a schema change. */
export function getWorkoutsForDate(characterId: string, dateStr: string): WorkoutSession[] {
  const sessionRows = db
    .prepare("SELECT id, date, notes FROM workout_sessions WHERE character_id = ? AND date = ? ORDER BY date")
    .all(characterId, dateStr) as SessionRow[];

  return sessionRows.map((row) => {
    const setRows = db
      .prepare("SELECT id, exercise_name, weight, reps, set_order FROM workout_sets WHERE session_id = ? ORDER BY set_order")
      .all(row.id) as SetRow[];
    return {
      id: row.id,
      date: row.date,
      notes: row.notes,
      sets: setRows.map((s) => ({
        id: s.id,
        exerciseName: s.exercise_name,
        weight: s.weight,
        reps: s.reps,
        setOrder: s.set_order,
      })),
    };
  });
}

/**
 * Mock stand-in for a real wger API poller — no real wger server exists
 * yet (Docker isn't installed on this machine, and setting one up without
 * it was judged too risky to attempt unattended; see
 * wger_gamification_implementation_plan.md). Seeds a couple of realistic
 * sessions directly into the same mirror table a real poller would write
 * to, so the RPC query and Tauri modal above/around this can be built and
 * verified end-to-end tonight. Swapping in a real wger HTTP client later
 * means replacing this function's call site (server/index.ts) with a
 * real poll loop — not a schema or query change.
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
