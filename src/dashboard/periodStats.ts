import { ActivityStat } from "./stats";
import { GoalHistorySummary } from "../goals/history";
import { sendQuery } from "../client/remoteState";

/** Query wrapper — real logic server-side now (server/periodStats.ts), including the Statistic modal's Period tab's own free-form date range. */
export interface RangeGoalProgress {
  activityLabel: string;
  targetMinutes: number;
  minutes: number;
  done: boolean;
}

export interface PeriodStatsResult {
  goalProgress: RangeGoalProgress[];
  mostCompleted: GoalHistorySummary["mostCompleted"];
  mostSkipped: GoalHistorySummary["mostSkipped"];
  activityStats: ActivityStat[];
}

export function computePeriodStats(start: Date, end: Date): Promise<PeriodStatsResult> {
  return sendQuery<PeriodStatsResult>("computePeriodStats", { startIso: start.toISOString(), endIso: end.toISOString() });
}

// Kept so viewer-main.ts's `import type { FixedPeriodKey, FixedPeriodStats }`
// keeps resolving (type-only, erased at build time — the viewer never runs
// this file's code). computeFixedPeriodStats itself has no client caller
// anymore; it moved server-side (server/periodStats.ts) for the push
// scheduler, which is the only thing that ever needed the 4 fixed windows.
export type FixedPeriodKey = "thisWeek" | "lastWeek" | "thisMonth" | "lastMonth";

export interface FixedPeriodStats extends PeriodStatsResult {
  key: FixedPeriodKey;
  label: string;
}
