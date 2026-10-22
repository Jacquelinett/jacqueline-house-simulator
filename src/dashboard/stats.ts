import { sendQuery } from "../client/remoteState";

/**
 * Query wrapper now — the real AW-querying implementation lives server-
 * side (server/stats.ts, a necessary duplicate once this file's job
 * changed; see that file's comment). Type shapes are kept identical and
 * exported from here unchanged specifically so viewer-main.ts's existing
 * `import type { ActivityStat }` keeps resolving — that import is erased
 * at build time (type-only), so the viewer never actually runs this
 * file's code or pulls in remoteState.ts.
 */
export interface ActivityStat {
  label: string;
  color: number;
  totalMinutesAllTime: number;
  averageMinutesPerDay: number;
}

export function getActivityStats(): Promise<ActivityStat[]> {
  return sendQuery<ActivityStat[]>("getActivityStats");
}

export interface DateActivityStat {
  label: string;
  color: number;
  minutes: number;
}

/** `viewingCharacterId` (optional) fetches another character's activity for this date instead of your own — see dashboard/panel.ts's "peek at another character" feature. */
export function getActivityStatsForDate(dateStr: string, viewingCharacterId?: string): Promise<DateActivityStat[]> {
  return sendQuery<DateActivityStat[]>("getActivityStatsForDate", { dateStr, viewingCharacterId });
}
