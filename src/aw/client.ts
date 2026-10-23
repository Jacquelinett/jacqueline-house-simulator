import { AWClient } from "aw-client";

// Reuses aw-webui's own manual-stopwatch bucket/schema (type "general.stopwatch",
// data: { running: boolean, label: string }), confirmed against a live aw-server.
// This keeps our tracked time visible in aw-webui's own Stopwatch view too,
// not just this app. One aw-server instance, one bucket per character
// (bucketId is now a parameter everywhere below, not a fixed constant) — see
// server/characters.ts for where each character's own bucket id comes from.
const BUCKET_TYPE = "general.stopwatch";
const BUCKET_HOSTNAME = "unknown";
// AW's category rules only match an event's `app`/`title` fields (not
// arbitrary data keys) — `label` alone is invisible to categorization, which
// is why nothing was showing up grouped in the dashboard. Set up a category
// rule in AW's Settings matching against these (e.g. a regex on `title`,
// or on `app` to bucket everything from this app under one category).
const APP_NAME = "House Simulator";

const REFRESH_INTERVAL_SEC = 10;

// aw-client defaults to http://127.0.0.1:5600 when no baseURL is given — correct
// for the non-Docker dev flow (`npm run server` on the same machine as a
// locally-installed aw-server, per CLAUDE.md's "stays on loopback relative to
// the Node server"). Once this server and aw-server run as separate Docker
// Compose containers, loopback no longer reaches aw-server at all — Compose's
// service-name DNS (e.g. `http://aw-server:5600`) is needed instead. AW_HOST/
// AW_PORT let docker-compose.yml override this per-deployment without
// touching the default behavior anyone running `npm run server` directly
// still gets when the env vars are unset.
//
// `process` is read off `globalThis` (cast through `any`) rather than typed
// directly — this file lives under src/, so the desktop app's own root
// tsconfig.json (DOM lib, no @types/node) typechecks it too even though
// nothing under src/ actually imports it anymore; a direct `process.env`
// reference would fail that build with "Cannot find name 'process'".
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const awHost = env?.AW_HOST;
const client = new AWClient("house-simulator", awHost ? { baseURL: `http://${awHost}:${env?.AW_PORT ?? 5600}` } : undefined);

export interface RunningActivity {
  id: number;
  label: string;
  startedAt: Date;
}

// Two characters can have independent running activities at the same time,
// each in their own bucket — keyed by bucketId instead of one shared variable.
const currentByBucket = new Map<string, RunningActivity | null>();
const refreshTimerByBucket = new Map<string, ReturnType<typeof setInterval>>();

/**
 * A switch the user just made that hasn't reached AW yet — see
 * startActivity's own comment for the full grace-period design. At most one
 * per bucket; staging a new one (or reverting to whatever's still actually
 * committed) always discards whichever was already pending first, since an
 * abandoned pending switch was never sent to AW to begin with.
 */
interface PendingSwitch {
  label: string;
  startedAt: Date;
  timer: ReturnType<typeof setTimeout>;
}
const pendingByBucket = new Map<string, PendingSwitch>();

export async function getServerInfo() {
  return client.getInfo();
}

export async function ensureStopwatchBucket(bucketId: string): Promise<void> {
  await client.ensureBucket(bucketId, BUCKET_TYPE, BUCKET_HOSTNAME);
}

/**
 * The activity to actually SHOW as current — a pending (not-yet-committed-
 * to-AW) switch if one is mid-grace-period, otherwise whatever's really
 * running in AW. Display-only: nothing that writes to AW ever reads this
 * (internal control flow below reads currentByBucket directly), since a
 * pending entry's startedAt may not correspond to any real AW event yet —
 * that's the whole point, see startActivity. `id` is meaningless for a
 * pending entry (no AW event exists for it yet) and is never read by any
 * caller of this function; -1 is just a placeholder.
 */
export function getCurrentActivity(bucketId: string): RunningActivity | null {
  const pending = pendingByBucket.get(bucketId);
  if (pending) return { id: -1, label: pending.label, startedAt: pending.startedAt };
  return currentByBucket.get(bucketId) ?? null;
}

/**
 * Keeps the running event's duration caught up to real elapsed time by always
 * replacing it by its known id — never AW's own `heartbeat` endpoint, whose
 * merge-into-last-event-or-insert-new decision depends on the gap since the
 * last call staying under its pulsetime. Browsers/webviews throttle
 * `setInterval` in backgrounded windows, which can silently stretch that gap
 * past any pulsetime and split one continuous session into two events. An
 * explicit by-id replace recomputes duration fresh from wall-clock time every
 * tick, so it's correct regardless of how long a tick was actually delayed.
 */
function beginRefreshing(bucketId: string, label: string) {
  const existing = refreshTimerByBucket.get(bucketId);
  if (existing) clearInterval(existing);

  refreshTimerByBucket.set(
    bucketId,
    setInterval(() => {
      const current = currentByBucket.get(bucketId);
      if (!current) return;
      client
        .replaceEvent(bucketId, {
          id: current.id,
          timestamp: current.startedAt,
          duration: (Date.now() - current.startedAt.getTime()) / 1000,
          data: { running: true, label, title: label, app: APP_NAME },
        })
        .catch((err) => console.error("[aw] periodic refresh failed", err));
    }, REFRESH_INTERVAL_SEC * 1000),
  );
}

/**
 * Only one House Simulator activity may be `running: true` in a given bucket
 * at a time — finalizes whatever's there before anything new starts. Closing
 * the app no longer auto-stops tracking (e.g. an overnight sleep-tracking
 * entry should keep accruing time with the app shut), so a *different*
 * activity being started is the actual point something earlier needs to be
 * closed out, and it may not be reflected in our in-memory state (e.g. after
 * a restart). `at` is the real moment the old activity actually stopped —
 * "now" for an immediate switch, or a grace-period switch's original
 * pending.startedAt when backdating a delayed commit (see commitPendingSwitch).
 */
async function stopWhateverIsRunning(bucketId: string, at: Date): Promise<void> {
  const current = currentByBucket.get(bucketId);
  if (current) {
    await closeRunningEvent(bucketId, current, at);
    return;
  }
  const [latest] = await client.getEvents(bucketId, { limit: 1 });
  if (!latest?.data.running) return;
  await client.replaceEvent(bucketId, {
    id: latest.id!,
    timestamp: latest.timestamp,
    duration: (at.getTime() - latest.timestamp.getTime()) / 1000,
    data: { ...latest.data, running: false },
  });
}

/** Shared tail end of both the explicit stopActivity() and a grace-period commit's "stop the old activity" step — closes `current`'s AW event out at `at`. */
async function closeRunningEvent(bucketId: string, current: RunningActivity, at: Date): Promise<void> {
  const refreshTimer = refreshTimerByBucket.get(bucketId);
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimerByBucket.delete(bucketId);
  }
  const duration = (at.getTime() - current.startedAt.getTime()) / 1000;
  await client.replaceEvent(bucketId, {
    id: current.id,
    timestamp: current.startedAt,
    duration,
    data: { running: false, label: current.label, title: current.label, app: APP_NAME },
  });
  currentByBucket.set(bucketId, null);
}

/** Opens a new AW event for `label`, backdated to `startedAt` — "now" for an immediate switch (duration starts at ~0), or a grace period's original switch moment for a delayed commit (duration seeded to the elapsed grace period instead of 0, so AW reflects the real elapsed time immediately rather than waiting for the next 10s refresh tick to catch up). */
async function insertRunningEvent(bucketId: string, label: string, startedAt: Date): Promise<void> {
  await client.insertEvent(bucketId, {
    timestamp: startedAt,
    duration: (Date.now() - startedAt.getTime()) / 1000,
    data: { running: true, label, title: label, app: APP_NAME },
  });

  const [latest] = await client.getEvents(bucketId, { limit: 1 });
  currentByBucket.set(bucketId, { id: latest.id!, label, startedAt: latest.timestamp });
  beginRefreshing(bucketId, label);
}

/**
 * Actually commits a pending switch to AW once its grace period has fully
 * elapsed with no further switch — backdates both the old activity's stop
 * and the new one's start to the exact moment the user originally switched
 * (pending.startedAt), not to "now" (now is gracePeriodSeconds later), so
 * AW's own event durations reflect when things really happened rather than
 * when this app got around to telling AW about it.
 */
async function commitPendingSwitch(bucketId: string): Promise<void> {
  const pending = pendingByBucket.get(bucketId);
  if (!pending) return; // already cancelled (switched again, or switched back) before the timer fired
  pendingByBucket.delete(bucketId);
  await stopWhateverIsRunning(bucketId, pending.startedAt);
  await insertRunningEvent(bucketId, pending.label, pending.startedAt);
}

/**
 * Switches to `label`, but doesn't touch AW right away — stages it as a
 * pending switch, shown as the current activity immediately (see
 * getCurrentActivity), and only actually commits it to AW (closing out
 * whatever was running, starting this one, both backdated to the moment of
 * this call) if `gracePeriodSeconds` passes with no further switch. This is
 * what lets testing something brief (an animation, an accidental tap) not
 * clutter the AW bucket with a flurry of tiny events: switching BACK to
 * whatever was actually still running in AW before the grace period is up
 * just discards the pending switch outright — that AW event was never
 * touched in the first place, so it resumes with its own timer
 * uninterrupted, not stopped-and-restarted. `gracePeriodSeconds` <= 0
 * disables this entirely (commits immediately, the pre-grace-period
 * behavior) — see Character.activityGracePeriodSeconds.
 */
export async function startActivity(bucketId: string, label: string, gracePeriodSeconds: number): Promise<void> {
  const pending = pendingByBucket.get(bucketId);
  const committed = currentByBucket.get(bucketId);

  // Already the effective current activity — a no-op, same as re-clicking
  // an already-running action elsewhere in this app.
  if ((pending?.label ?? committed?.label) === label) return;

  // Switching back to whatever's actually still open in AW cancels the
  // pending detour outright — nothing to undo, since it was never sent.
  if (pending && committed?.label === label) {
    clearTimeout(pending.timer);
    pendingByBucket.delete(bucketId);
    return;
  }

  // An earlier in-flight pending switch (to something else) never reached
  // AW either — just discard it in favor of this new one.
  if (pending) clearTimeout(pending.timer);

  if (gracePeriodSeconds <= 0) {
    pendingByBucket.delete(bucketId);
    const startedAt = new Date();
    await stopWhateverIsRunning(bucketId, startedAt);
    await insertRunningEvent(bucketId, label, startedAt);
    return;
  }

  const startedAt = new Date();
  const timer = setTimeout(() => {
    commitPendingSwitch(bucketId).catch((err) => console.error("[aw] committing pending activity switch failed", err));
  }, gracePeriodSeconds * 1000);
  pendingByBucket.set(bucketId, { label, startedAt, timer });
}

/**
 * Picks back up whatever's still marked running in AW when the server
 * (re)starts — e.g. an overnight sleep-tracking session left running on
 * purpose, or just a restart without calling stopActivity. Extends the
 * existing event's duration to cover the real elapsed time (which goes stale
 * while nothing's open to send heartbeats) rather than truncating it or
 * leaving a second, parallel event running alongside it.
 */
export async function resumeActivity(bucketId: string): Promise<RunningActivity | null> {
  const [latest] = await client.getEvents(bucketId, { limit: 1 });
  if (!latest?.data.running) return null;

  const label = latest.data.label as string;
  await client.replaceEvent(bucketId, {
    id: latest.id!,
    timestamp: latest.timestamp,
    duration: (Date.now() - latest.timestamp.getTime()) / 1000,
    data: latest.data,
  });

  const current = { id: latest.id!, label, startedAt: latest.timestamp };
  currentByBucket.set(bucketId, current);
  beginRefreshing(bucketId, label);
  return current;
}

/**
 * Sums tracked duration for an activity label within [start, end), in
 * minutes — the general form behind getTodayDurationMinutes (today's one
 * calendar day) and historical stats (all-time totals, rolling averages).
 */
export async function getDurationMinutes(bucketId: string, label: string, range: { start: Date; end: Date }): Promise<number> {
  const events = await client.getEvents(bucketId, range);
  const totalSeconds = events
    .filter((e) => e.data.label === label)
    .reduce((sum, e) => sum + (e.duration ?? 0), 0);
  return totalSeconds / 60;
}

/** "Since this character started tracking anything in House Simulator" — epoch is a safe start, since nothing's labeled this way before the app existed. */
export async function getAllTimeDurationMinutes(bucketId: string, label: string): Promise<number> {
  return getDurationMinutes(bucketId, label, { start: new Date(0), end: new Date() });
}

/**
 * Sums today's (local midnight to now) tracked duration for an activity
 * label, in minutes. `excludeRunning` leaves out whatever's currently
 * running — useful for a caller that's going to add that session's live
 * elapsed time back in itself (e.g. computed client-side on a remote viewer
 * from a pushed `startedAt`, instead of needing a fresh fetch every tick).
 */
export async function getTodayDurationMinutes(
  bucketId: string,
  label: string,
  options?: { excludeRunning?: boolean },
): Promise<number> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const events = await client.getEvents(bucketId, { start: startOfDay, end: now });
  const totalSeconds = events
    .filter((e) => e.data.label === label)
    .filter((e) => !(options?.excludeRunning && e.data.running))
    .reduce((sum, e) => sum + (e.duration ?? 0), 0);
  return totalSeconds / 60;
}

/**
 * The explicit "Stop Activity" button — always a full, immediate stop,
 * bypassing the grace period entirely: discards any pending (not-yet-
 * committed) switch outright (nothing to send to AW for it) and closes out
 * whatever's actually still running in AW right now. Unlike startActivity,
 * there's no "stop pending, stop later" concept — stopping is already the
 * dedicated, deliberate action (see CLAUDE.md's "Stopping is a dedicated
 * button" section), so it takes effect immediately rather than itself being
 * subject to a grace period.
 */
export async function stopActivity(bucketId: string): Promise<void> {
  const pending = pendingByBucket.get(bucketId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingByBucket.delete(bucketId);
  }

  const current = currentByBucket.get(bucketId);
  if (!current) return;
  await closeRunningEvent(bucketId, current, new Date());
}
