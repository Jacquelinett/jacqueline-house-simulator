import { getAllTimeDurationMinutes, getDurationMinutes } from "../aw/client";
import { addDaysToDateString, localDateString, parseDateString } from "../goals/recurrence";
import { ACTIVITIES } from "../scene/activities";

const AVERAGE_WINDOW_DAYS = 30;

export interface ActivityStat {
  label: string;
  color: number;
  totalMinutesAllTime: number;
  averageMinutesPerDay: number; // over the trailing AVERAGE_WINDOW_DAYS
}

/** Every known activity's all-time total and a rolling daily average — the two pieces of "gamified dashboard" data that are pure AW queries, no new storage needed. */
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

/**
 * Plain minutes-per-activity actually tracked on a single day — no pie,
 * just a list, since one day doesn't need a composition breakdown the way
 * an average does. For the real current day this runs up to "now" rather
 * than midnight, so the Dashboard's live 30s refresh keeps picking up the
 * running session; any other day (the date picker looking at a past/future
 * day) runs the full midnight-to-midnight range instead.
 */
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

/**
 * Same shape as `ActivityStat` (total + average/day) but scoped to
 * [start, end) instead of all-time — Statistic's Period tab (a week or a
 * month). Unlike `getActivityStats`'s all-time average, which deliberately
 * uses a rolling 30-day window so a newly added activity doesn't look
 * negligible forever, a period is already a fixed, small window — total
 * tracked time divided by the period's own day count is just that period's
 * actual daily average, nothing to smooth out.
 */
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
