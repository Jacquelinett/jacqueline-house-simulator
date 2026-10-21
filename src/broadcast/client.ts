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

/** No-ops quietly if broadcasting isn't configured yet, or the request fails — this is a nice-to-have, never something that should disrupt the app. */
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
    await fetch(`${broadcastUrl}/api/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        activityLabel: current?.label ?? null,
        startedAt: current?.startedAt.toISOString() ?? null,
        todayMinutesByLabel,
      }),
    });
  } catch (err) {
    console.error("[broadcast] failed to push status", err);
  }
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
    await fetch(`${broadcastUrl}/api/goals`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(getGoals()),
    });
  } catch (err) {
    console.error("[broadcast] failed to push goals", err);
  }
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
