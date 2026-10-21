import { getCurrentActivity } from "../aw/client";
import { getTodayGoalProgress } from "../goals/progress";
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
  const goals = await getTodayGoalProgress();

  try {
    await fetch(`${broadcastUrl}/api/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        activityLabel: current?.label ?? null,
        startedAt: current?.startedAt.toISOString() ?? null,
        goals,
      }),
    });
  } catch (err) {
    console.error("[broadcast] failed to push status", err);
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
