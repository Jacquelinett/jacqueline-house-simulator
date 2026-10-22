import { getCurrentActivity } from "../aw/client";
import { getGoals } from "../goals/state";
import { getTodayMinutesByLabel } from "../goals/progress";
import { getTodayStreaksByGoalId } from "../goals/history";
import { getActivityStats, getActivityStatsForDate } from "../dashboard/stats";
import { computeFixedPeriodStats } from "../dashboard/periodStats";
import { addDaysToDateString, localDateString } from "../goals/recurrence";
import { getSettings } from "../settings/state";

export interface InboxMessage {
  id: number;
  author: string | null;
  text: string;
  created_at: string;
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${getSettings().broadcastSecret}` };
}

export interface BroadcastHealth {
  lastSuccessAt: Date | null;
  lastError: string | null;
}

let health: BroadcastHealth = { lastSuccessAt: null, lastError: null };
const healthListeners = new Set<() => void>();

export function getBroadcastHealth(): BroadcastHealth {
  return health;
}

/** Fires after every push attempt, success or failure — not just on change, since "still failing" is as worth re-showing as "just recovered." */
export function onBroadcastHealthChange(cb: () => void): void {
  healthListeners.add(cb);
}

function notifyHealth() {
  for (const cb of healthListeners) cb();
}

// fetch() only rejects on network-level failures — an HTTP error status
// (e.g. a 500 from a server-side bug) resolves normally and was previously
// going completely undetected, not even reaching console.error.
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

/**
 * No-ops quietly if broadcasting isn't configured yet; a configured-but-
 * failing push updates `getBroadcastHealth()` instead of disrupting the
 * app. Returns whether the push actually succeeded — most callers ignore
 * it (same fire-and-forget usage as before), but a caller that only wants
 * to redo expensive local work once a push has actually landed (e.g.
 * pushYesterdayStats below) needs to know, rather than assuming success.
 */
async function pushWithHealth(path: string, body: unknown, errorContext: string): Promise<boolean> {
  const { broadcastUrl } = getSettings();
  if (!broadcastUrl) return false;

  try {
    await putJson(`${broadcastUrl}${path}`, body);
    health = { lastSuccessAt: new Date(), lastError: null };
    notifyHealth();
    return true;
  } catch (err) {
    console.error(`[broadcast] failed to push ${errorContext}`, err);
    health = { ...health, lastError: (err as Error).message };
    notifyHealth();
    return false;
  }
}

export async function pushStatus(): Promise<void> {
  const current = getCurrentActivity();
  // Excludes whatever's currently running — the viewer adds that session's
  // live elapsed time itself from `startedAt`, the same way it already
  // computes the live "Running for X" clock, instead of this needing to be
  // re-pushed on a timer just to keep a running goal's progress from
  // looking stale.
  const todayMinutesByLabel = await getTodayMinutesByLabel();
  await pushWithHealth(
    "/api/status",
    { activityLabel: current?.label ?? null, startedAt: current?.startedAt.toISOString() ?? null, todayMinutesByLabel },
    "status",
  );
}

/**
 * Pushes the raw goal definitions (targets + schedules, not progress) —
 * called whenever goals change, independent of activity changes, so editing
 * a goal shows up for viewers immediately instead of waiting for the next
 * activity switch to piggyback a fresh push on.
 */
export async function pushGoals(): Promise<void> {
  await pushWithHealth("/api/goals", getGoals(), "goals");
}

/**
 * Pushes per-activity all-time totals + rolling daily averages — meant to be
 * called on a slow cadence (startup + hourly, not per activity-change),
 * since computing it means scanning a much wider AW history than the
 * today-only queries everything else here uses.
 */
export async function pushStats(): Promise<void> {
  await pushWithHealth("/api/stats", await getActivityStats(), "stats");
}

/**
 * Pushes the 4 fixed This Week/Last Week/This Month/Last Month buckets —
 * the viewer has no AW access to run its own arbitrary-range queries, so
 * instead of a date picker it gets whatever was last computed here, picked
 * from this fixed list. Rides the same hourly timer as pushStats (called
 * alongside it in main.ts) rather than a separate once-a-day scheduler —
 * simpler than tracking day boundaries here too, and This Week/This Month
 * genuinely want that cadence since they change through the day.
 * computeFixedPeriodStats() itself skips redoing the AW query for Last
 * Week/Last Month once nothing could have changed, so the "every hour"
 * here is about keeping the push (and This Week/This Month) fresh, not
 * about redundantly recomputing the other two.
 */
export async function pushPeriodStats(): Promise<void> {
  await pushWithHealth("/api/period-stats", await computeFixedPeriodStats(), "period stats");
}

/**
 * Pushes yesterday's tracked minutes per label — a settled, complete day,
 * unlike today's (which is still live). The viewer's Dashboard panel has
 * no AW access to query an arbitrary day, so instead of a date picker it
 * gets a Today/Yesterday hyperlink toggle: "today" is what it already has
 * from /api/status, "yesterday" is this. Reuses getActivityStatsForDate
 * (already used by the desktop Dashboard's own date picker) rather than
 * writing a new aggregation — just reshaped into a plain label->minutes
 * map, the same shape /api/status already pushes for today.
 *
 * Yesterday never changes once the day is over, so re-querying AW for it
 * every hour (this rides the same timer as pushStats/pushPeriodStats) is
 * pure waste — this only actually does the query+push once per calendar
 * day, tracked by which "today" it last ran for. Only advances that
 * tracker on a successful push, so a transient val.town outage still
 * retries next hour instead of being silently skipped for the rest of the
 * day.
 */
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

/**
 * Pushes each of today's scheduled recurring goals' current streak length,
 * keyed by goal id. Same "once per calendar day" gating as
 * pushYesterdayStats, for the same reason — a goal's current streak
 * doesn't change outside of settlement (which itself only runs once a
 * day), so there's nothing new to compute or push until "today" changes.
 * getTodayStreaksByGoalId() is the only source for this; the viewer has
 * no history log of its own to derive it from (goal.highestStreak rides
 * along with the already-pushed /api/goals for free, but the *current*
 * length can't).
 */
let streaksPushedForToday: string | null = null;

export async function pushTodayStreaks(): Promise<void> {
  const todayStr = localDateString(new Date());
  if (streaksPushedForToday === todayStr) return;

  const ok = await pushWithHealth("/api/streaks", getTodayStreaksByGoalId(), "today's streaks");
  if (ok) streaksPushedForToday = todayStr;
}

export async function fetchMessages(): Promise<InboxMessage[]> {
  const { broadcastUrl } = getSettings();
  if (!broadcastUrl) return [];
  const res = await fetch(`${broadcastUrl}/api/messages`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`failed to fetch messages (${res.status})`);
  return res.json();
}

export async function deleteMessage(id: number): Promise<void> {
  const { broadcastUrl } = getSettings();
  if (!broadcastUrl) return;
  const res = await fetch(`${broadcastUrl}/api/messages/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`failed to delete message (${res.status})`);
}
