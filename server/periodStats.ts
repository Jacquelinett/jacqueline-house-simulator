import { ActivityStat, getActivityStatsForRange } from "../src/dashboard/stats";
import { localDateString, periodRange, PeriodMode } from "../src/goals/recurrence";
import { getGoalProgressForRange, RangeGoalProgress } from "./progress";
import { summarizeGoalHistory, GoalHistorySummary } from "./goalHistory";
import { goalHistoryStore } from "./stores/goalHistoryStore";

/** Server-side home for src/dashboard/periodStats.ts's logic — identical except history comes from goalHistoryStore's indexed range query instead of loading+filtering the whole (now server-only) history log. */
export interface PeriodStatsResult {
  goalProgress: RangeGoalProgress[];
  mostCompleted: GoalHistorySummary["mostCompleted"];
  mostSkipped: GoalHistorySummary["mostSkipped"];
  activityStats: ActivityStat[];
}

export async function computePeriodStats(start: Date, end: Date): Promise<PeriodStatsResult> {
  const goalProgress = await getGoalProgressForRange(start, end);

  const startStr = localDateString(start);
  const endStr = localDateString(end);
  const history = goalHistoryStore.getInRange(startStr, endStr);
  const { mostCompleted, mostSkipped } = summarizeGoalHistory(history);

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

async function computeNamedPeriod(key: FixedPeriodKey, today: Date): Promise<FixedPeriodStats> {
  const { start, end, label } = periodRange(FIXED_PERIOD_MODE[key], anchorFor(key, today));
  const stats = await computePeriodStats(start, end);
  return { key, label, ...stats };
}

interface CachedPeriod {
  startKey: string;
  stats: FixedPeriodStats;
}

let cachedLastWeek: CachedPeriod | null = null;
let cachedLastMonth: CachedPeriod | null = null;

async function computeCachedPeriod(key: "lastWeek" | "lastMonth", today: Date, cache: CachedPeriod | null): Promise<CachedPeriod> {
  const { start } = periodRange(FIXED_PERIOD_MODE[key], anchorFor(key, today));
  const startKey = localDateString(start);
  if (cache && cache.startKey === startKey) return cache;
  return { startKey, stats: await computeNamedPeriod(key, today) };
}

export async function computeFixedPeriodStats(): Promise<FixedPeriodStats[]> {
  const today = new Date();

  const [thisWeek, thisMonth, lastWeekCache, lastMonthCache] = await Promise.all([
    computeNamedPeriod("thisWeek", today),
    computeNamedPeriod("thisMonth", today),
    computeCachedPeriod("lastWeek", today, cachedLastWeek),
    computeCachedPeriod("lastMonth", today, cachedLastMonth),
  ]);
  cachedLastWeek = lastWeekCache;
  cachedLastMonth = lastMonthCache;

  return [thisWeek, lastWeekCache.stats, thisMonth, lastMonthCache.stats];
}
