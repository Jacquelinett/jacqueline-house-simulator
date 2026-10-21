export type Recurrence =
  | { type: "once"; date: string } // "YYYY-MM-DD", local date
  | { type: "weekly"; daysOfWeek: Weekday[] }
  | { type: "monthly"; occurrence: 1 | 2 | 3 | 4 | "last"; dayOfWeek: Weekday };

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
}
