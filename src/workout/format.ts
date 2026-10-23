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

/**
 * "22.5kg × 5 (×5), 60kg × 8 (×2), 60kg × 7" (or "8 reps" for a bodyweight
 * set with no recorded weight) — collapses consecutive-or-not sets that
 * share the exact same weight/unit/reps into one entry with a "(×N)"
 * count, rather than repeating an identical line N times (the common case
 * for a real lift: 5 sets of the same weight×reps read as noise, not
 * signal, listed out individually). Grouped by exact (weight, unit, reps)
 * match regardless of position in the list — not just adjacent runs — so
 * e.g. a warm-up set repeated later still collapses into the same count.
 * A lone set (count 1) omits the "(×1)" suffix entirely, since there's
 * nothing to collapse. Defaults a missing weightUnit to "kg" (the old mock
 * mirror never set one, and always implied kg).
 */
export function formatSetDetail(sets: WorkoutSet[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const s of sets) {
    const key = `${s.weight ?? "none"}|${s.weightUnit ?? "kg"}|${s.reps}`;
    if (!counts.has(key)) {
      order.push(key);
      labels.set(key, s.weight != null ? `${s.weight}${s.weightUnit ?? "kg"} × ${s.reps}` : `${s.reps} reps`);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return order.map((key) => (counts.get(key)! > 1 ? `${labels.get(key)} (×${counts.get(key)})` : labels.get(key))).join(", ");
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
