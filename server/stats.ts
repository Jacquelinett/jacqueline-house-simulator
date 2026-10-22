import { getAllTimeDurationMinutes, getDurationMinutes } from "../src/aw/client";
import { addDaysToDateString, localDateString, parseDateString } from "../src/goals/recurrence";
import { ACTIVITIES } from "../src/scene/activities";

/**
 * Server-side home for src/dashboard/stats.ts's logic, verbatim — this
 * one actually needed copying (not just reusing by import) once the
 * client's own copy became a query-wrapper in Phase 5: both can't be the
 * same file path with two different implementations. Unlike
 * goals/state.ts etc., this wasn't already duplicated back in Phase 2
 * (it had zero goals/state.ts dependency, so direct reuse looked safe at
 * the time) — this is that duplication finally happening, now that it's
 * actually needed.
 */
const AVERAGE_WINDOW_DAYS = 30;

export interface ActivityStat {
  label: string;
  color: number;
  totalMinutesAllTime: number;
  averageMinutesPerDay: number;
}

export async function getActivityStats(): Promise<ActivityStat[]> {
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - AVERAGE_WINDOW_DAYS);

  const stats = await Promise.all(
    Object.values(ACTIVITIES).map(async (activity) => {
      const [totalMinutesAllTime, windowMinutes] = await Promise.all([
        getAllTimeDurationMinutes(activity.label),
        getDurationMinutes(activity.label, { start: windowStart, end: now }),
      ]);
      return {
        label: activity.label,
        color: activity.color,
        totalMinutesAllTime,
        averageMinutesPerDay: windowMinutes / AVERAGE_WINDOW_DAYS,
      };
    }),
  );

  return stats.sort((a, b) => b.totalMinutesAllTime - a.totalMinutesAllTime);
}

export interface DateActivityStat {
  label: string;
  color: number;
  minutes: number;
}

export async function getActivityStatsForDate(dateStr: string): Promise<DateActivityStat[]> {
  const date = parseDateString(dateStr);
  const isToday = dateStr === localDateString(new Date());
  const end = isToday ? new Date() : parseDateString(addDaysToDateString(dateStr, 1));

  const stats = await Promise.all(
    Object.values(ACTIVITIES).map(async (activity) => ({
      label: activity.label,
      color: activity.color,
      minutes: await getDurationMinutes(activity.label, { start: date, end }),
    })),
  );

  return stats.filter((s) => s.minutes > 0).sort((a, b) => b.minutes - a.minutes);
}

export async function getActivityStatsForRange(start: Date, endExclusive: Date): Promise<ActivityStat[]> {
  const days = Math.max(1, (endExclusive.getTime() - start.getTime()) / 86_400_000);

  const stats = await Promise.all(
    Object.values(ACTIVITIES).map(async (activity) => {
      const totalMinutesAllTime = await getDurationMinutes(activity.label, { start, end: endExclusive });
      return { label: activity.label, color: activity.color, totalMinutesAllTime, averageMinutesPerDay: totalMinutesAllTime / days };
    }),
  );

  return stats.sort((a, b) => b.totalMinutesAllTime - a.totalMinutesAllTime);
}
