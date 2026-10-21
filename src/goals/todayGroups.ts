import { isScheduledOn, localDateString } from "./recurrence";
import { describeRecurrence } from "./ui";
import { Goal, Recurrence } from "./types";

export interface TodayGoalGroup {
  activityLabel: string;
  targetMinutes: number;
  goals: Goal[];
}

/**
 * Groups every goal scheduled on `today` by activity label (AW only
 * measures time per label, not per goal, so a daily recurring goal plus a
 * one-off "extra today" for the same activity need to be summed into one
 * combined target rather than tracked as two independent ones). The
 * desktop Dashboard, its progress calculation, and the viewer's own
 * client-side equivalent were all independently re-deriving this same
 * grouping before — this is the one place it happens now.
 */
export function groupTodaysGoals(goals: Goal[], today: Date): TodayGoalGroup[] {
  const todayStr = localDateString(today);
  const scheduled = goals.filter((g) => isScheduledOn(g.recurrence, today) && !g.skipDates?.includes(todayStr));

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

// A one-off goal's literal date is always just "today" on any of these
// today-only views — showing it plainly is clearer than the generic "once
// (2026-10-21)" phrasing describeRecurrence() uses elsewhere (e.g. the
// manage modal, where goals for OTHER days are visible too and the real
// date still matters there).
export function describeScheduleForToday(recurrence: Recurrence): string {
  return recurrence.type === "once" ? "Today" : describeRecurrence(recurrence);
}
