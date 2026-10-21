import { AWClient } from "aw-client";

// Reuses aw-webui's own manual-stopwatch bucket/schema (type "general.stopwatch",
// data: { running: boolean, label: string }), confirmed against a live aw-server.
// This keeps our tracked time visible in aw-webui's own Stopwatch view too,
// not just this app.
const BUCKET_ID = "aw-stopwatch";
const BUCKET_TYPE = "general.stopwatch";
const BUCKET_HOSTNAME = "unknown";
// AW's category rules only match an event's `app`/`title` fields (not
// arbitrary data keys) — `label` alone is invisible to categorization, which
// is why nothing was showing up grouped in the dashboard. Set up a category
// rule in AW's Settings matching against these (e.g. a regex on `title`,
// or on `app` to bucket everything from this app under one category).
const APP_NAME = "House Simulator";

const REFRESH_INTERVAL_SEC = 10;

const client = new AWClient("house-simulator");

export interface RunningActivity {
  id: number;
  label: string;
  startedAt: Date;
}

let current: RunningActivity | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export async function getServerInfo() {
  return client.getInfo();
}

export async function ensureStopwatchBucket(): Promise<void> {
  await client.ensureBucket(BUCKET_ID, BUCKET_TYPE, BUCKET_HOSTNAME);
}

export function getCurrentActivity(): RunningActivity | null {
  return current;
}

/**
 * Keeps `current`'s event duration caught up to real elapsed time by always
 * replacing it by its known id — never AW's own `heartbeat` endpoint, whose
 * merge-into-last-event-or-insert-new decision depends on the gap since the
 * last call staying under its pulsetime. Browsers/webviews throttle
 * `setInterval` in backgrounded windows, which can silently stretch that gap
 * past any pulsetime and split one continuous session into two events. An
 * explicit by-id replace recomputes duration fresh from wall-clock time every
 * tick, so it's correct regardless of how long a tick was actually delayed.
 */
function beginRefreshing(label: string) {
  refreshTimer = setInterval(() => {
    if (!current) return;
    client
      .replaceEvent(BUCKET_ID, {
        id: current.id,
        timestamp: current.startedAt,
        duration: (Date.now() - current.startedAt.getTime()) / 1000,
        data: { running: true, label, title: label, app: APP_NAME },
      })
      .catch((err) => console.error("[aw] periodic refresh failed", err));
  }, REFRESH_INTERVAL_SEC * 1000);
}

/**
 * Only one House Simulator activity may be `running: true` in AW at a time —
 * finalizes whatever's there before anything new starts. Closing the app no
 * longer auto-stops tracking (e.g. an overnight sleep-tracking entry should
 * keep accruing time with the app shut), so a *different* activity being
 * started is the actual point something earlier needs to be closed out, and
 * it may not be reflected in our in-memory `current` (e.g. after a restart).
 */
async function stopWhateverIsRunning(): Promise<void> {
  if (current) {
    await stopActivity();
    return;
  }
  const [latest] = await client.getEvents(BUCKET_ID, { limit: 1 });
  if (!latest?.data.running) return;
  await client.replaceEvent(BUCKET_ID, {
    id: latest.id!,
    timestamp: latest.timestamp,
    duration: (Date.now() - latest.timestamp.getTime()) / 1000,
    data: { ...latest.data, running: false },
  });
}

export async function startActivity(label: string): Promise<void> {
  if (current?.label === label) return;
  await stopWhateverIsRunning();

  const timestamp = new Date();
  await client.insertEvent(BUCKET_ID, {
    timestamp,
    duration: 0,
    data: { running: true, label, title: label, app: APP_NAME },
  });

  const [latest] = await client.getEvents(BUCKET_ID, { limit: 1 });
  current = { id: latest.id!, label, startedAt: latest.timestamp };
  beginRefreshing(label);
}

/**
 * Picks back up whatever's still marked running in AW when the app (re)opens
 * — e.g. an overnight sleep-tracking session left running on purpose, or just
 * the app being closed without calling stopActivity. Extends the existing
 * event's duration to cover the real elapsed time (which goes stale while the
 * app isn't open to send heartbeats) rather than truncating it or leaving a
 * second, parallel event running alongside it.
 */
export async function resumeActivity(): Promise<RunningActivity | null> {
  const [latest] = await client.getEvents(BUCKET_ID, { limit: 1 });
  if (!latest?.data.running) return null;

  const label = latest.data.label as string;
  await client.replaceEvent(BUCKET_ID, {
    id: latest.id!,
    timestamp: latest.timestamp,
    duration: (Date.now() - latest.timestamp.getTime()) / 1000,
    data: latest.data,
  });

  current = { id: latest.id!, label, startedAt: latest.timestamp };
  beginRefreshing(label);
  return current;
}

/**
 * Sums tracked duration for an activity label within [start, end), in
 * minutes — the general form behind getTodayDurationMinutes (today's one
 * calendar day) and historical stats (all-time totals, rolling averages).
 */
export async function getDurationMinutes(label: string, range: { start: Date; end: Date }): Promise<number> {
  const events = await client.getEvents(BUCKET_ID, range);
  const totalSeconds = events
    .filter((e) => e.data.label === label)
    .reduce((sum, e) => sum + (e.duration ?? 0), 0);
  return totalSeconds / 60;
}

/** "Since you started tracking anything in House Simulator" — epoch is a safe start, since nothing's labeled this way before the app existed. */
export async function getAllTimeDurationMinutes(label: string): Promise<number> {
  return getDurationMinutes(label, { start: new Date(0), end: new Date() });
}

/**
 * Sums today's (local midnight to now) tracked duration for an activity
 * label, in minutes. `excludeRunning` leaves out whatever's currently
 * running — useful for a caller that's going to add that session's live
 * elapsed time back in itself (e.g. computed client-side on a remote viewer
 * from a pushed `startedAt`, instead of needing a fresh fetch every tick).
 */
export async function getTodayDurationMinutes(label: string, options?: { excludeRunning?: boolean }): Promise<number> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const events = await client.getEvents(BUCKET_ID, { start: startOfDay, end: now });
  const totalSeconds = events
    .filter((e) => e.data.label === label)
    .filter((e) => !(options?.excludeRunning && e.data.running))
    .reduce((sum, e) => sum + (e.duration ?? 0), 0);
  return totalSeconds / 60;
}

export async function stopActivity(): Promise<void> {
  if (!current) return;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  const stoppedAt = new Date();
  const duration = (stoppedAt.getTime() - current.startedAt.getTime()) / 1000;
  await client.replaceEvent(BUCKET_ID, {
    id: current.id,
    timestamp: current.startedAt,
    duration,
    data: { running: false, label: current.label, title: current.label, app: APP_NAME },
  });
  current = null;
}
