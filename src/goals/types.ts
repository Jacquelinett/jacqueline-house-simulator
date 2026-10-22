export type Recurrence =
  | { type: "once"; date: string } // "YYYY-MM-DD", local date
  | { type: "daily" }
  | { type: "weekly"; daysOfWeek: Weekday[] }
  | { type: "monthly"; occurrences: (1 | 2 | 3 | 4 | "last")[]; dayOfWeek: Weekday };

export type Weekday = "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";

export interface Goal {
  id: string;
  activityLabel: string;
  targetMinutes: number;
  recurrence: Recurrence;
  /** "YYYY-MM-DD" dates this recurring goal is skipped on, without deleting the series. */
  skipDates?: string[];
  /**
   * "YYYY-MM-DD" the goal was added — bounds how far back history-settling
   * ever looks for this goal. Optional only because goals created before
   * this field existed don't have one; treated as "no history before now"
   * rather than guessed.
   */
  createdAt?: string;
  /**
   * Streak bookkeeping for recurring goals only (a one-off "once" goal has
   * no repetition to streak), maintained incrementally by
   * `settleGoalHistory()` as each new scheduled day settles — never
   * recomputed from scratch, so these are always current as of the last
   * settle. `streakStartDate` ("YYYY-MM-DD") anchors the *current* streak:
   * set to the day a streak starts, and re-set to the day of a loss
   * whenever one happens (even though that day itself isn't a completion —
   * see history.ts's `getCurrentStreakLength` for why that's still
   * correct). `highestStreak` only ever ratchets up, never resets.
   */
  streakStartDate?: string;
  highestStreak?: number;
}
