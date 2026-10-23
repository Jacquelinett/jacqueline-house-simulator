/**
 * Shared shape for "one day of logged workout data," regardless of whether
 * it's backed by the mock SQLite mirror or a real wger instance (see
 * server/workouts.ts/server/wger.ts, CLAUDE.md's wger section) — pulled out
 * of src/workout/modal.ts (which originally declared these as local,
 * mock-only interfaces) so server/workouts.ts, server/wger.ts, and the new
 * Dashboard section (src/workout/format.ts) can all import one definition
 * instead of three copies silently drifting apart.
 */
export interface WorkoutSet {
  id: string;
  exerciseName: string;
  weight: number | null;
  /** "kg"/"lb", whatever the source recorded — null for the old mock data (which always implied kg) or if wger's own unit lookup failed. See formatSetDetail()'s own default. */
  weightUnit: string | null;
  reps: number;
  setOrder: number;
}

export interface WorkoutSession {
  id: string;
  date: string;
  notes: string | null;
  sets: WorkoutSet[];
}
