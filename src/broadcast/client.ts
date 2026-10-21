import { getCurrentActivity } from "../aw/client";
import { getGoals } from "../goals/state";
import { getTodayMinutesByLabel } from "../goals/progress";
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

/** No-ops quietly if broadcasting isn't configured yet; a configured-but-failing push updates `getBroadcastHealth()` instead of disrupting the app. */
export async function pushStatus(): Promise<void> {
  const { broadcastUrl } = getSettings();
  if (!broadcastUrl) return;

  const current = getCurrentActivity();
  // Excludes whatever's currently running — the viewer adds that session's
  // live elapsed time itself from `startedAt`, the same way it already
  // computes the live "Running for X" clock, instead of this needing to be
  // re-pushed on a timer just to keep a running goal's progress from
  // looking stale.
  const todayMinutesByLabel = await getTodayMinutesByLabel();

  try {
    await putJson(`${broadcastUrl}/api/status`, {
      activityLabel: current?.label ?? null,
      startedAt: current?.startedAt.toISOString() ?? null,
      todayMinutesByLabel,
    });
    health = { lastSuccessAt: new Date(), lastError: null };
  } catch (err) {
    console.error("[broadcast] failed to push status", err);
    health = { ...health, lastError: (err as Error).message };
  }
  notifyHealth();
}

/**
 * Pushes the raw goal definitions (targets + schedules, not progress) —
 * called whenever goals change, independent of activity changes, so editing
 * a goal shows up for viewers immediately instead of waiting for the next
 * activity switch to piggyback a fresh push on.
 */
export async function pushGoals(): Promise<void> {
  const { broadcastUrl } = getSettings();
  if (!broadcastUrl) return;

  try {
    await putJson(`${broadcastUrl}/api/goals`, getGoals());
    health = { lastSuccessAt: new Date(), lastError: null };
  } catch (err) {
    console.error("[broadcast] failed to push goals", err);
    health = { ...health, lastError: (err as Error).message };
  }
  notifyHealth();
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
