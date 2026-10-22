import { getCurrentActivity } from "../src/aw/client";
import { getGoals } from "./goals";
import { getTodayMinutesByLabel } from "./progress";
import { getTodayStreaksByGoalId } from "./goalHistory";
import { getActivityStats, getActivityStatsForDate } from "./stats";
import { computeFixedPeriodStats } from "./periodStats";
import { addDaysToDateString, localDateString } from "../src/goals/recurrence";
import { getServerConfig } from "./serverConfig";
import { Character, getCharacterById } from "./characters";
import { getActivities } from "./activities";
import { getObjectTypes } from "./objectTypes";
import { getRoomSpecs } from "./rooms";
import { getFloors } from "./floors";

/**
 * Server-side home for src/broadcast/client.ts's push functions — same
 * logic, except broadcastUrl/broadcastSecret come from getServerConfig()
 * (hand-edited on the home server) instead of per-device Settings, since
 * only the server pushes to val.town now. Scheduling (what used to be
 * main.ts's setInterval) lives in server/index.ts, not here.
 *
 * val.town/the public viewer can show any admin-published character now
 * (see server/characters.ts's publishToViewer), not just Jacqueline —
 * every push function below still takes a characterId explicitly (which
 * characters actually get pushed is still decided at each call site in
 * server/index.ts/rpc.ts, not hardcoded in here), but now also resolves
 * and sends that character's id/name so val.town can key each blob by
 * character instead of storing one global singleton row.
 */
function characterOrThrow(characterId: string): Character {
  const character = getCharacterById(characterId);
  if (!character) throw new Error(`unknown character: ${characterId}`);
  return character;
}
function bucketIdFor(characterId: string): string {
  return characterOrThrow(characterId).awBucketId;
}
/** Every per-character PUT body includes this, so val.town can store/key each blob by character — see valtown/houseSimulatorStatus.ts's schema. characterSpriteName only actually gets stored by the status table (which doubles as the character directory — see handleGetAll's own comment), but rides along harmlessly on every other blob too rather than needing its own special-cased field list. */
function characterFields(characterId: string): { characterId: string; characterName: string; characterSpriteName: string | null } {
  const character = characterOrThrow(characterId);
  return { characterId: character.id, characterName: character.name, characterSpriteName: character.spriteName };
}
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

export async function pushStatus(characterId: string): Promise<void> {
  const current = getCurrentActivity(bucketIdFor(characterId));
  const todayMinutesByLabel = await getTodayMinutesByLabel(characterId);
  await pushWithHealth(
    "/api/status",
    { ...characterFields(characterId), activityLabel: current?.label ?? null, startedAt: current?.startedAt.toISOString() ?? null, todayMinutesByLabel },
    "status",
  );
}

export async function pushGoals(characterId: string): Promise<void> {
  await pushWithHealth("/api/goals", { ...characterFields(characterId), goals: getGoals(characterId) }, "goals");
}

/**
 * The house layout itself — activities/object types/rooms (incl. their
 * objects and connections)/floors, the same four things the WebSocket
 * protocol sends a connected game client once on connect. The viewer has
 * no WebSocket connection at all, so without this it was stuck rendering
 * whatever STATIC_ROOM_SPECS/STATIC_ACTIVITIES/STATIC_OBJECT_TYPES/
 * STATIC_FLOORS happened to be baked into its own bundle at the last
 * `npm run build:viewer` — any admin-tool edit (resize a room, move a
 * connection, add an activity, ...) never reached it at all. Global data,
 * not per-character (unlike every other push function above) — one blob,
 * not scoped to Jacqueline specifically.
 *
 * Called from adminApi.ts after every mutation that changes any of the
 * four tables, and once at server startup — admin-tool edits are rare
 * enough that push-on-change is simpler and fresher than any polling
 * interval would be, same reasoning pushGoals already uses.
 */
export async function pushHouseLayout(): Promise<void> {
  await pushWithHealth(
    "/api/house-layout",
    { activities: getActivities(), objectTypes: getObjectTypes(), rooms: getRoomSpecs(), floors: getFloors() },
    "house layout",
  );
}

export async function pushStats(characterId: string): Promise<void> {
  await pushWithHealth("/api/stats", { ...characterFields(characterId), stats: await getActivityStats(characterId) }, "stats");
}

export async function pushPeriodStats(characterId: string): Promise<void> {
  await pushWithHealth(
    "/api/period-stats",
    { ...characterFields(characterId), periodStats: await computeFixedPeriodStats(characterId) },
    "period stats",
  );
}

// Keyed by characterId — now that more than one character can be
// published, a single shared string would make the SECOND published
// character's push silently skip for the rest of the day the moment the
// FIRST one's already gone out, since both would share one "have I
// pushed for today" flag.
const yesterdayPushedForToday = new Map<string, string>();

export async function pushYesterdayStats(characterId: string): Promise<void> {
  const todayStr = localDateString(new Date());
  if (yesterdayPushedForToday.get(characterId) === todayStr) return;

  const yesterday = addDaysToDateString(todayStr, -1);
  const stats = await getActivityStatsForDate(characterId, yesterday);
  const minutesByLabel = Object.fromEntries(stats.map((s) => [s.label, s.minutes]));
  const ok = await pushWithHealth("/api/yesterday", { ...characterFields(characterId), minutesByLabel }, "yesterday stats");
  if (ok) yesterdayPushedForToday.set(characterId, todayStr);
}

// Same per-character reasoning as yesterdayPushedForToday above.
const streaksPushedForToday = new Map<string, string>();

export async function pushTodayStreaks(characterId: string): Promise<void> {
  const todayStr = localDateString(new Date());
  if (streaksPushedForToday.get(characterId) === todayStr) return;

  const ok = await pushWithHealth(
    "/api/streaks",
    { ...characterFields(characterId), streaksByGoalId: getTodayStreaksByGoalId(characterId) },
    "today's streaks",
  );
  if (ok) streaksPushedForToday.set(characterId, todayStr);
}

/**
 * For the Jacqueline panel's "VT: Synced..." line — `configured` used to
 * be a client-side `!!getSettings().broadcastUrl` check; now that
 * broadcastUrl lives in server_config instead of per-device Settings,
 * the client has to ask the server for this too, via a query (polled on
 * the same interval the panel already re-renders on).
 */
export function getBroadcastHealthInfo(): BroadcastHealth & { configured: boolean } {
  return { ...health, configured: !!getServerConfig().broadcastUrl };
}

export interface InboxMessage {
  id: number;
  author: string | null;
  text: string;
  created_at: string;
}

/** Proxies the in-app inbox through the server, same reason pushing moved here — the client no longer has broadcastUrl/broadcastSecret locally to call val.town directly. */
export async function fetchMessages(): Promise<InboxMessage[]> {
  const { broadcastUrl } = getServerConfig();
  if (!broadcastUrl) return [];
  const res = await fetch(`${broadcastUrl}/api/messages`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`failed to fetch messages (${res.status})`);
  return (await res.json()) as InboxMessage[];
}

export async function deleteMessage(id: number): Promise<void> {
  const { broadcastUrl } = getServerConfig();
  if (!broadcastUrl) return;
  const res = await fetch(`${broadcastUrl}/api/messages/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`failed to delete message (${res.status})`);
}
