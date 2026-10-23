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
 * One line per distinct (weight, unit, reps) combo among the given sets —
 * e.g. ["22.5kg × 5 (×5)", "25kg × 3"] for 5 sets at 22.5kg plus a single
 * set at 25kg — sorted lightest to heaviest (bodyweight/no-recorded-weight
 * sets sort last, since there's nothing to compare numerically) rather
 * than left in whatever order wger happened to log them. Collapses sets
 * that share the exact same weight/unit/reps into one entry with a "(×N)"
 * count, rather than repeating an identical line N times (the common case
 * for a real lift: 5 sets of the same weight×reps read as noise, not
 * signal, listed out individually) — matched by exact value regardless of
 * position, not just adjacent runs, so e.g. a warm-up weight repeated
 * later still collapses into the same count. A lone set (count 1) omits
 * the "(×1)" suffix entirely, since there's nothing to collapse. Defaults
 * a missing weightUnit to "kg" (the old mock mirror never set one, and
 * always implied kg).
 */
export function formatSetDetail(sets: WorkoutSet[]): string[] {
  const counts = new Map<string, number>();
  const weights = new Map<string, number | null>();
  const labels = new Map<string, string>();
  for (const s of sets) {
    const key = `${s.weight ?? "none"}|${s.weightUnit ?? "kg"}|${s.reps}`;
    if (!counts.has(key)) {
      weights.set(key, s.weight);
      labels.set(key, s.weight != null ? `${s.weight}${s.weightUnit ?? "kg"} × ${s.reps}` : `${s.reps} reps`);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = [...counts.keys()].sort((a, b) => {
    const wa = weights.get(a)!;
    const wb = weights.get(b)!;
    if (wa == null && wb == null) return 0;
    if (wa == null) return 1;
    if (wb == null) return -1;
    return wa - wb;
  });
  return keys.map((key) => (counts.get(key)! > 1 ? `${labels.get(key)} (×${counts.get(key)})` : labels.get(key)!));
}

export interface WorkoutTodayEntry {
  exerciseName: string;
  details: string[];
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
  return [...grouped.entries()].map(([exerciseName, sets]) => ({ exerciseName, details: formatSetDetail(sets) }));
}
