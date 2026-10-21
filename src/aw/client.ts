import { AWClient } from "aw-client";

// Reuses aw-webui's own manual-stopwatch bucket/schema (type "general.stopwatch",
// data: { running: boolean, label: string }), confirmed against a live aw-server:
// a `heartbeat()` with unchanged data merges into one continuous event, and
// `replaceEvent()` finalizes it on stop. This keeps our tracked time visible in
// aw-webui's own Stopwatch view too, not just this app.
const BUCKET_ID = "aw-stopwatch";
const BUCKET_TYPE = "general.stopwatch";
const BUCKET_HOSTNAME = "unknown";
// AW's category rules only match an event's `app`/`title` fields (not
// arbitrary data keys) — `label` alone is invisible to categorization, which
// is why nothing was showing up grouped in the dashboard. Set up a category
// rule in AW's Settings matching against these (e.g. a regex on `title`,
// or on `app` to bucket everything from this app under one category).
const APP_NAME = "House Simulator";

const HEARTBEAT_INTERVAL_SEC = 10;
const PULSETIME_SEC = HEARTBEAT_INTERVAL_SEC * 2;

const client = new AWClient("house-simulator");

export interface RunningActivity {
  id: number;
  label: string;
  startedAt: Date;
}

let current: RunningActivity | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export async function getServerInfo() {
  return client.getInfo();
}

export async function ensureStopwatchBucket(): Promise<void> {
  await client.ensureBucket(BUCKET_ID, BUCKET_TYPE, BUCKET_HOSTNAME);
}

export function getCurrentActivity(): RunningActivity | null {
  return current;
}

export async function startActivity(label: string): Promise<void> {
  if (current?.label === label) return;
  if (current) await stopActivity();

  const timestamp = new Date();
  await client.heartbeat(BUCKET_ID, PULSETIME_SEC, {
    timestamp,
    data: { running: true, label, title: label, app: APP_NAME },
  });

  const [latest] = await client.getEvents(BUCKET_ID, { limit: 1 });
  current = { id: latest.id!, label, startedAt: latest.timestamp };

  heartbeatTimer = setInterval(() => {
    client
      .heartbeat(BUCKET_ID, PULSETIME_SEC, {
        timestamp: new Date(),
        data: { running: true, label, title: label, app: APP_NAME },
      })
      .catch((err) => console.error("[aw] heartbeat failed", err));
  }, HEARTBEAT_INTERVAL_SEC * 1000);
}

export async function stopActivity(): Promise<void> {
  if (!current) return;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
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
