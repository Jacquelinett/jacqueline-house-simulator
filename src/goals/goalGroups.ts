import { isScheduledOn, localDateString } from "./recurrence";
import { describeRecurrence } from "./format";
import { Goal, Recurrence } from "./types";

export interface GoalGroup {
  activityLabel: string;
  targetMinutes: number;
  goals: Goal[];
}

/**
 * Groups every goal scheduled on `date` by activity label (AW only
 * measures time per label, not per goal, so a daily recurring goal plus a
 * one-off "extra today" for the same activity need to be summed into one
 * combined target rather than tracked as two independent ones). Used for
 * "today" everywhere that used to be the only caller, but also for
 * arbitrary past/future dates (the Dashboard date picker, Statistic's
 * Period tab) — a goal created after `date` is excluded, since it wasn't
 * actually scheduled yet on a day before it existed.
 */
export function groupGoalsForDate(goals: Goal[], date: Date): GoalGroup[] {
  const dateStr = localDateString(date);
  const scheduled = goals.filter(
    (g) => (!g.createdAt || g.createdAt <= dateStr) && isScheduledOn(g.recurrence, date) && !g.skipDates?.includes(dateStr),
  );

  const groups = new Map<string, Goal[]>();
  for (const goal of scheduled) {
    const group = groups.get(goal.activityLabel);
    if (group) group.push(goal);
    else groups.set(goal.activityLabel, [goal]);
  }

  return [...groups].map(([activityLabel, group]) => ({
    activityLabel,
    targetMinutes: group.reduce((sum, g) => sum + g.targetMinutes, 0),
    goals: group,
  }));
}

// A one-off goal's literal date is always just `dateStr` on any of these
// single-day views — showing it plainly as "Today" when dateStr happens to
// be the real current day is clearer than the generic "once (2026-10-21)"
// phrasing describeRecurrence() uses elsewhere (e.g. the manage modal,
// where goals for OTHER days are visible too and the real date still
// matters there). For any other dateStr (a past/future day picked via a
// date picker), the real date is shown instead — "Today" would be wrong.
export function describeScheduleForDate(recurrence: Recurrence, dateStr: string): string {
  if (recurrence.type === "once") return dateStr === localDateString(new Date()) ? "Today" : recurrence.date;
  return describeRecurrence(recurrence);
}
