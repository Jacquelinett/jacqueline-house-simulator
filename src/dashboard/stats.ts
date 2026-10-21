import { getAllTimeDurationMinutes, getDurationMinutes } from "../aw/client";
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
