import { getGoalProgressForRange, RangeGoalProgress } from "../goals/progress";
import { getGoalHistory, summarizeGoalHistory, GoalHistorySummary } from "../goals/history";
import { getActivityStatsForRange, ActivityStat } from "./stats";
import { localDateString, periodRange, PeriodMode } from "../goals/recurrence";

export interface PeriodStatsResult {
  goalProgress: RangeGoalProgress[];
  mostCompleted: GoalHistorySummary["mostCompleted"];
  mostSkipped: GoalHistorySummary["mostSkipped"];
  activityStats: ActivityStat[];
}

/**
 * Everything the Statistic modal's Period tab shows for one [start, end)
 * window — goal progress, most completed/skipped within it, and activity
 * totals. The one place this three-source aggregation happens, so the
 * desktop Period tab (statisticModal.ts, a free-form date picker) and the
 * fixed-bucket push to val.town (computeFixedPeriodStats below, for the
 * viewer) compute it identically instead of each re-deriving it.
 */
export async function computePeriodStats(start: Date, end: Date): Promise<PeriodStatsResult> {
  const goalProgress = await getGoalProgressForRange(start, end);

  const startStr = localDateString(start);
  const endStr = localDateString(end);
  const history = getGoalHistory().filter((h) => h.date >= startStr && h.date < endStr);
  const { mostCompleted, mostSkipped } = summarizeGoalHistory(history);

  // Unlike getGoalProgressForRange (which already tolerates a per-label AW
  // failure internally), getActivityStatsForRange has no such fallback —
  // without this, one failed query would reject the whole aggregate for
  // both callers below (the desktop Period tab's render, and the push to
  // val.town), instead of just showing/pushing an empty activity section.
  const activityStats = await getActivityStatsForRange(start, end).catch((err) => {
    console.error("[periodStats] failed to load activity stats", err);
    return [];
  });

  return { goalProgress, mostCompleted, mostSkipped, activityStats };
}

export type FixedPeriodKey = "thisWeek" | "lastWeek" | "thisMonth" | "lastMonth";

export interface FixedPeriodStats extends PeriodStatsResult {
  key: FixedPeriodKey;
  label: string;
}

const FIXED_PERIOD_MODE: Record<FixedPeriodKey, PeriodMode> = {
  thisWeek: "weekly",
  lastWeek: "weekly",
  thisMonth: "monthly",
  lastMonth: "monthly",
};

function anchorFor(key: FixedPeriodKey, today: Date): Date {
  switch (key) {
    case "thisWeek":
    case "thisMonth":
      return today;
    case "lastWeek":
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
    case "lastMonth":
      return new Date(today.getFullYear(), today.getMonth() - 1, 1);
  }
}

/**
 * The 4 fixed windows pushed to val.town on a slow cadence (see
 * broadcast/client.ts's pushPeriodStats) so the viewer — which has no AW
 * access to run its own arbitrary-range queries — can still show more than
 * just today: This Week/Last Week/This Month/Last Month, picked from a
 * fixed list instead of a free date picker.
 */
export async function computeFixedPeriodStats(): Promise<FixedPeriodStats[]> {
  const today = new Date();
  const keys: FixedPeriodKey[] = ["thisWeek", "lastWeek", "thisMonth", "lastMonth"];
  return Promise.all(
    keys.map(async (key) => {
      const { start, end, label } = periodRange(FIXED_PERIOD_MODE[key], anchorFor(key, today));
      const stats = await computePeriodStats(start, end);
      return { key, label, ...stats };
    }),
  );
}
