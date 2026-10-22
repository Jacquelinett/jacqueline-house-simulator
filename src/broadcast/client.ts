import { sendCommand, sendQuery } from "../client/remoteState";

export interface InboxMessage {
  id: number;
  author: string | null;
  text: string;
  created_at: string;
}

export interface BroadcastHealth {
  configured: boolean;
  lastSuccessAt: Date | null;
  lastError: string | null;
}

/**
 * The actual pushing (pushStatus/pushGoals/pushStats/...) moved
 * server-side entirely (server/broadcast.ts) — this file only has what
 * the UI still needs to *read*: sync health (for the Jacqueline panel's
 * "VT: Synced..." line, polled — see goals/panel.ts) and the message
 * inbox (the server proxies val.town since broadcastUrl/broadcastSecret
 * aren't known client-side anymore).
 */
export async function getBroadcastHealth(): Promise<BroadcastHealth> {
  const result = await sendQuery<{ configured: boolean; lastSuccessAt: string | null; lastError: string | null }>(
    "getBroadcastHealth",
  );
  return { ...result, lastSuccessAt: result.lastSuccessAt ? new Date(result.lastSuccessAt) : null };
}

export async function fetchMessages(): Promise<InboxMessage[]> {
  return sendQuery<InboxMessage[]>("fetchMessages");
}

export async function deleteMessage(id: number): Promise<void> {
  sendCommand("deleteMessage", { id });
}
