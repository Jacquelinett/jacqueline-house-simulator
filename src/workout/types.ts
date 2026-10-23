/**
 * Shared shape for "one day of logged workout data" — real wger data only
 * now (see server/workouts.ts/server/wger.ts, CLAUDE.md's wger section);
 * pulled out of src/workout/modal.ts (which originally declared these as
 * local interfaces) so server/workouts.ts, server/wger.ts, and
 * src/workout/format.ts can all import one definition instead of three
 * copies silently drifting apart.
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

/** wger's own lifetime-aggregate stats (`/api/v2/user-statistics/`) — computed by wger itself, not derived here. */
export interface WgerLifetimeStats {
  totalWeightLifted: number;
  /** wger doesn't report a unit for this field — assumed kg, same default every other weight display in this app falls back to. */
  totalWeightLiftedUnit: string;
  totalWorkouts: number;
  currentStreak: number;
  longestStreak: number;
  lastWorkoutDate: string | null;
}

/** One wger-detected personal record (a "pr"-type trophy, see server/wger.ts's getWgerPersonalRecords) — wger awards one of these automatically the moment a logged set beats your previous best for that exercise, 1RM estimate included for free. */
export interface PersonalRecord {
  exerciseName: string;
  weight: number;
  weightUnit: string | null;
  reps: number;
  oneRepMaxEstimate: number | null;
  /** The date the record-setting SET was logged, not when wger got around to detecting/awarding the trophy for it. */
  date: string;
}

/**
 * One recent workout day (`/api/v2/workoutsession/`, grouped by exercise)
 * — the one representation of "what did I log recently" shared by the
 * Statistic modal's Workout > Logs section (desktop app, src/workout/
 * render.ts) AND the viewer's own equivalent (pushed via val.town, see
 * server/broadcast.ts's pushWgerSummary), instead of the app keeping a
 * separate, finer-grained session-by-session view: that used to exist as
 * its own `RecentSession` type (exact start/end, free-text notes, no
 * exercise grouping), dropped once the Statistic modal's Workout tab was
 * unified across desktop/mobile/viewer — one shared shape, one shared
 * render function, real start/end times included (not stripped the way
 * an earlier, more private-by-default version of this type did — see git
 * history if that's ever needed again).
 */
export interface DaySummary {
  date: string;
  datetimeStart: string;
  datetimeEnd: string | null;
  exercises: { exerciseName: string; details: string[] }[];
  impression: "bad" | "neutral" | "good" | null;
}
