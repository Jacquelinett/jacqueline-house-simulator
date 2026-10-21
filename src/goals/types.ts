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
}
