import { getCurrentActivity } from "../src/aw/client";
import { getGoals } from "./goals";
import { getTodayMinutesByLabel } from "./progress";
import { getTodayStreaksByGoalId } from "./goalHistory";
import { getActivityStats, getActivityStatsForDate } from "../src/dashboard/stats";
import { computeFixedPeriodStats } from "./periodStats";
import { addDaysToDateString, localDateString } from "../src/goals/recurrence";
import { getServerConfig } from "./serverConfig";

/**
 * Server-side home for src/broadcast/client.ts's push functions — same
 * logic, except broadcastUrl/broadcastSecret come from getServerConfig()
 * (hand-edited on the home server) instead of per-device Settings, since
 * only the server pushes to val.town now. Scheduling (what used to be
 * main.ts's setInterval) lives in server/index.ts, not here.
 */
function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getServerConfig().broadcastSecret ?? ""}` };
}

export interface BroadcastHealth {
  lastSuccessAt: Date | null;
  lastError: string | null;
}

let health: BroadcastHealth = { lastSuccessAt: null, lastError: null };

export function getBroadcastHealth(): BroadcastHealth {
  return health;
}

async function putJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
  }
}

async function pushWithHealth(path: string, body: unknown, errorContext: string): Promise<boolean> {
  const { broadcastUrl } = getServerConfig();
  if (!broadcastUrl) return false;

  try {
    await putJson(`${broadcastUrl}${path}`, body);
    health = { lastSuccessAt: new Date(), lastError: null };
    return true;
  } catch (err) {
    console.error(`[broadcast] failed to push ${errorContext}`, err);
    health = { ...health, lastError: (err as Error).message };
    return false;
  }
}

export async function pushStatus(): Promise<void> {
  const current = getCurrentActivity();
  const todayMinutesByLabel = await getTodayMinutesByLabel();
  await pushWithHealth(
    "/api/status",
    { activityLabel: current?.label ?? null, startedAt: current?.startedAt.toISOString() ?? null, todayMinutesByLabel },
    "status",
  );
}

export async function pushGoals(): Promise<void> {
  await pushWithHealth("/api/goals", getGoals(), "goals");
}

export async function pushStats(): Promise<void> {
  await pushWithHealth("/api/stats", await getActivityStats(), "stats");
}

export async function pushPeriodStats(): Promise<void> {
  await pushWithHealth("/api/period-stats", await computeFixedPeriodStats(), "period stats");
}

let yesterdayPushedForToday: string | null = null;

export async function pushYesterdayStats(): Promise<void> {
  const todayStr = localDateString(new Date());
  if (yesterdayPushedForToday === todayStr) return;

  const yesterday = addDaysToDateString(todayStr, -1);
  const stats = await getActivityStatsForDate(yesterday);
  const minutesByLabel = Object.fromEntries(stats.map((s) => [s.label, s.minutes]));
  const ok = await pushWithHealth("/api/yesterday", minutesByLabel, "yesterday stats");
  if (ok) yesterdayPushedForToday = todayStr;
}

let streaksPushedForToday: string | null = null;

export async function pushTodayStreaks(): Promise<void> {
  const todayStr = localDateString(new Date());
  if (streaksPushedForToday === todayStr) return;

  const ok = await pushWithHealth("/api/streaks", getTodayStreaksByGoalId(), "today's streaks");
  if (ok) streaksPushedForToday = todayStr;
}
