import { ActivityStat, getActivityStatsForRange } from "./stats";
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

export async function computePeriodStats(characterId: string, start: Date, end: Date): Promise<PeriodStatsResult> {
  const goalProgress = await getGoalProgressForRange(characterId, start, end);

  const startStr = localDateString(start);
  const endStr = localDateString(end);
  const history = goalHistoryStore.getInRange(characterId, startStr, endStr);
  const { mostCompleted, mostSkipped } = summarizeGoalHistory(history);

  const activityStats = await getActivityStatsForRange(characterId, start, end).catch((err) => {
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

async function computeNamedPeriod(characterId: string, key: FixedPeriodKey, today: Date): Promise<FixedPeriodStats> {
  const { start, end, label } = periodRange(FIXED_PERIOD_MODE[key], anchorFor(key, today));
  const stats = await computePeriodStats(characterId, start, end);
  return { key, label, ...stats };
}

interface CachedPeriod {
  startKey: string;
  stats: FixedPeriodStats;
}

let cachedLastWeek: CachedPeriod | null = null;
let cachedLastMonth: CachedPeriod | null = null;

async function computeCachedPeriod(
  characterId: string,
  key: "lastWeek" | "lastMonth",
  today: Date,
  cache: CachedPeriod | null,
): Promise<CachedPeriod> {
  const { start } = periodRange(FIXED_PERIOD_MODE[key], anchorFor(key, today));
  const startKey = localDateString(start);
  if (cache && cache.startKey === startKey) return cache;
  return { startKey, stats: await computeNamedPeriod(characterId, key, today) };
}

/** Only ever called for Jacqueline (the push scheduler's val.town-bound data) — see server/broadcast.ts. No RPC client caller; the Statistic modal's Period tab uses computePeriodStats() above instead. */
export async function computeFixedPeriodStats(characterId: string): Promise<FixedPeriodStats[]> {
  const today = new Date();

  const [thisWeek, thisMonth, lastWeekCache, lastMonthCache] = await Promise.all([
    computeNamedPeriod(characterId, "thisWeek", today),
    computeNamedPeriod(characterId, "thisMonth", today),
    computeCachedPeriod(characterId, "lastWeek", today, cachedLastWeek),
    computeCachedPeriod(characterId, "lastMonth", today, cachedLastMonth),
  ]);
  cachedLastWeek = lastWeekCache;
  cachedLastMonth = lastMonthCache;

  return [thisWeek, lastWeekCache.stats, thisMonth, lastMonthCache.stats];
}
