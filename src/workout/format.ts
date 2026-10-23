import { WorkoutSession, WorkoutSet } from "./types";

/** Groups a flat list of sets by exercise name, preserving first-appearance order — same reasoning a wger routine's own log view uses, not a flat list of individual sets. Pulled out of src/workout/modal.ts so the Dashboard "Lifted Today" section (below) can reuse it instead of re-deriving the same grouping. */
export function groupSetsByExercise(sets: WorkoutSet[]): Map<string, WorkoutSet[]> {
  const byExercise = new Map<string, WorkoutSet[]>();
  for (const set of sets) {
    const group = byExercise.get(set.exerciseName) ?? [];
    group.push(set);
    byExercise.set(set.exerciseName, group);
  }
  return byExercise;
}

/** "60kg × 8, 60kg × 8, 60kg × 7" (or "8 reps" for a bodyweight set with no recorded weight) — defaults a missing weightUnit to "kg" (the old mock mirror never set one, and always implied kg). Pulled out of src/workout/modal.ts for the same reuse reason as groupSetsByExercise above. */
export function formatSetDetail(sets: WorkoutSet[]): string {
  return sets.map((s) => (s.weight != null ? `${s.weight}${s.weightUnit ?? "kg"} × ${s.reps}` : `${s.reps} reps`)).join(", ");
}

export interface WorkoutTodayEntry {
  exerciseName: string;
  detail: string;
}

/**
 * Flattens every set across every session on the day (there's usually just
 * one session, but nothing stops there being two) into one exercise-grouped
 * summary — what the Dashboard's "Lifted Today" section actually renders.
 * Deliberately a simpler, coarser view than the Workout modal's own
 * per-session rendering (which keeps sessions separate so it can show each
 * one's notes) — the Dashboard callout is a "yes, pride-worthy activity
 * happened today" glance, not a full log.
 */
export function summarizeWorkoutSessions(sessions: WorkoutSession[]): WorkoutTodayEntry[] {
  const allSets = sessions.flatMap((s) => s.sets);
  const grouped = groupSetsByExercise(allSets);
  return [...grouped.entries()].map(([exerciseName, sets]) => ({ exerciseName, detail: formatSetDetail(sets) }));
}
