import { WebSocket, WebSocketServer } from "ws";
import { getCurrentActivity, startActivity, stopActivity } from "../src/aw/client";
import { getActivityStats, getActivityStatsForDate } from "./stats";
import { DeviceSettings } from "../src/settings/types";
import {
  addGoal,
  deleteGoal,
  getGoals,
  onGoalsChange,
  skipGoalToday,
  unskipGoalToday,
  updateGoal,
} from "./goals";
import { getAllHistory, getTodayStreaksByGoalId, historyForGoal } from "./goalHistory";
import { getGoalProgressForDate, getTodayMinutesByLabel } from "./progress";
import { computePeriodStats } from "./periodStats";
import { addTodo, deleteTodo, getTodos, onTodosChange, toggleTodo } from "./todos";
import { deleteMessage, fetchMessages, getBroadcastHealthInfo, pushStatus } from "./broadcast";
import { getDeviceSettings, updateDeviceSettings } from "./deviceSettings";
import { Character, getCharacterBySecret, listCharacters } from "./characters";
import { activityLabelHasLiveObject } from "./activityGuard";
import { getWorkoutsForDate, getLifetimeStatsForCharacter, getPersonalRecordsForCharacter, getRecentSessionsForCharacter } from "./workouts";
import { getActivities } from "./activities";
import { getObjectTypes } from "./objectTypes";
import { getRoomSpecs } from "./rooms";
import { getFloors } from "./floors";

/**
 * One WebSocket connection per client carries everything — commands
 * (fire-and-forget writes, server rebroadcasts the affected state to the
 * SAME character's other connected clients after applying), queries
 * (request/response, correlated by requestId), and unsolicited state
 * broadcasts on change. Command/query names map 1:1 onto the functions
 * above via these two dispatch tables, now always taking the connection's
 * resolved characterId as their first argument. `updateSettings` is
 * handled separately below (not in this table) since settings are scoped
 * by deviceId, not characterId.
 */
const commands: Record<string, (characterId: string, args: any) => Promise<void>> = {
  startActivity: (characterId, { label }) => startActivity(bucketIdFor(characterId), label),
  stopActivity: (characterId) => stopActivity(bucketIdFor(characterId)),
  addGoal: (characterId, { activityLabel, targetMinutes, recurrence }) =>
    addGoal(characterId, activityLabel, targetMinutes, recurrence),
  updateGoal: (characterId, { id, activityLabel, targetMinutes, recurrence }) =>
    updateGoal(characterId, id, activityLabel, targetMinutes, recurrence),
  deleteGoal: (characterId, { id }) => deleteGoal(characterId, id),
  skipGoalToday: (characterId, { goalId }) => skipGoalToday(characterId, goalId),
  unskipGoalToday: (characterId, { goalId }) => unskipGoalToday(characterId, goalId),
  addTodo: (characterId, { text }) => addTodo(characterId, text),
  toggleTodo: (characterId, { id }) => toggleTodo(characterId, id),
  deleteTodo: (characterId, { id }) => deleteTodo(characterId, id),
  deleteMessage: (_characterId, { id }) => deleteMessage(id),
};

/**
 * `viewingCharacterId` (optional, in args) lets a client ask about a
 * DIFFERENT character than the one it authenticated as — used by the
 * Dashboard panel's "peek at another character" feature (see
 * House.ts/dashboard/panel.ts). No privacy boundary between household
 * characters by design, so the server trusts this outright rather than
 * checking it against anything; defaults to the caller's own id when
 * absent, same as every query behaved before this existed.
 */
const queries: Record<string, (characterId: string, args: any) => Promise<unknown>> = {
  getGoalProgressForDate: (characterId, { dateStr, viewingCharacterId }) => getGoalProgressForDate(viewingCharacterId ?? characterId, dateStr),
  getTodayMinutesByLabel: (characterId) => getTodayMinutesByLabel(characterId),
  getActivityStatsForDate: (characterId, { dateStr, viewingCharacterId }) => getActivityStatsForDate(viewingCharacterId ?? characterId, dateStr),
  getActivityStats: (characterId) => getActivityStats(characterId),
  computePeriodStats: (characterId, { startIso, endIso }) => computePeriodStats(characterId, new Date(startIso), new Date(endIso)),
  getTodayStreaksByGoalId: async (characterId) => getTodayStreaksByGoalId(characterId),
  getCurrentActivity: async (characterId) => getCurrentActivity(bucketIdFor(characterId)),
  getGoalHistory: async (characterId, { viewingCharacterId }) => getAllHistory(viewingCharacterId ?? characterId),
  historyForGoal: async (characterId, { goalId }) => historyForGoal(characterId, goalId),
  getWorkoutsForDate: async (characterId, { dateStr, viewingCharacterId }) => getWorkoutsForDate(viewingCharacterId ?? characterId, dateStr),
  getWgerLifetimeStats: async (characterId, { viewingCharacterId } = {}) => getLifetimeStatsForCharacter(viewingCharacterId ?? characterId),
  getWgerPersonalRecords: async (characterId, { viewingCharacterId } = {}) => getPersonalRecordsForCharacter(viewingCharacterId ?? characterId),
  getWgerRecentSessions: async (characterId, { viewingCharacterId } = {}) => getRecentSessionsForCharacter(viewingCharacterId ?? characterId),
  fetchMessages: (characterId) => fetchMessages(characterId),
  getBroadcastHealth: async () => getBroadcastHealthInfo(),
};

const characterCache = new Map<string, Character>();
function bucketIdFor(characterId: string): string {
  const character = characterCache.get(characterId);
  if (!character) throw new Error(`unknown character: ${characterId}`);
  return character.awBucketId;
}

function currentStatus(bucketId: string) {
  const current = getCurrentActivity(bucketId);
  return { activityLabel: current?.label ?? null, startedAt: current?.startedAt.toISOString() ?? null };
}

// Module-level (setupRpc() is only ever called once, from index.ts) rather
// than local to setupRpc(), specifically so stopOrphanedActivities() below
// can broadcast an auto-stop to a character's connected clients from
// outside the WS connection handler itself (called from index.ts at
// startup and from adminApi.ts after a mutation that could orphan a
// running activity).
const clients = new Set<WebSocket>();
const deviceIdByClient = new Map<WebSocket, string>();
const characterByClient = new Map<WebSocket, Character>();

/** Sends one character's data to only that character's own connected clients. */
function broadcastToCharacter(characterId: string, key: string, data: unknown) {
  const message = JSON.stringify({ type: "state", key, data });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN && characterByClient.get(client)?.id === characterId) {
      client.send(message);
    }
  }
}

/** Sends to every connected client regardless of which character they are — used for data every character's own client needs to see about every OTHER character too (currently just allStatuses). */
function broadcastToAll(key: string, data: unknown) {
  const message = JSON.stringify({ type: "state", key, data });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

export interface AllStatusesEntry {
  characterName: string;
  characterSpriteName: string | null;
  activityLabel: string;
  startedAt: string;
}

/**
 * Every character CURRENTLY running something, keyed by characterId —
 * absent means idle, same "no entry rather than a null placeholder" shape
 * as the rest of this codebase. This is what lets Jacqueline's own client
 * show that Kevin is doing something (scene overlay, click attribution —
 * see House.ts) without her ever being scoped to his own `status`
 * broadcast, which stays per-character/private to its own connections.
 */
function computeAllStatuses(): Record<string, AllStatusesEntry> {
  const result: Record<string, AllStatusesEntry> = {};
  for (const character of listCharacters()) {
    const current = getCurrentActivity(character.awBucketId);
    if (!current) continue;
    result[character.id] = {
      characterName: character.name,
      characterSpriteName: character.spriteName,
      activityLabel: current.label,
      startedAt: current.startedAt.toISOString(),
    };
  }
  return result;
}

function broadcastAllStatuses(): void {
  broadcastToAll("allStatuses", computeAllStatuses());
}

/**
 * Auto-stops `character`'s currently-running activity if the room/object
 * that was tracking it has since been deleted or reconfigured out from
 * under it (e.g. via the admin tool) — defaults back to idle rather than
 * leaving a session running for something that no longer exists anywhere
 * in the house.
 *
 * Checked once per connection (see wss.on("connection") below) rather than
 * reactively after every admin-tool edit — the admin tool doesn't change
 * rooms/objects/activities often enough to justify re-checking on every
 * single mutation, and "a client is starting a session" is both a more
 * natural checkpoint and the only moment this actually needs to be
 * correct (nobody's looking at a stale "running" state in between).
 */
async function stopIfOrphaned(character: Character): Promise<void> {
  const current = getCurrentActivity(character.awBucketId);
  if (!current) return;
  if (activityLabelHasLiveObject(current.label)) return;

  console.warn(`[rpc] "${current.label}" (tracked by ${character.name}) no longer has a live object — stopping and defaulting to idle`);
  await stopActivity(character.awBucketId);
  broadcastToCharacter(character.id, "status", currentStatus(character.awBucketId));
  broadcastAllStatuses();
  // Only published characters reach val.town/the viewer — see
  // server/characters.ts's own comment on publishToViewer.
  if (character.publishToViewer) {
    pushStatus(character.id).catch((err) => console.error("[rpc] pushStatus after auto-stop failed", err));
  }
}

/** Same check as stopIfOrphaned, swept across every character at once — used only at server startup (see index.ts), since a resumed session could be stale from before the last shutdown and nothing's connected yet to trigger the per-connection check above. */
export async function stopOrphanedActivities(): Promise<void> {
  for (const character of listCharacters()) {
    await stopIfOrphaned(character);
  }
}

export function setupRpc(wss: WebSocketServer): void {
  /**
   * goals/todos changing doesn't carry *which* character changed (one
   * shared in-memory store underneath, see server/goals.ts's own comment)
   * — so on any change, every connected client gets its own re-sent slice
   * recomputed from its own characterId, rather than threading "who
   * changed" through the generic onGoalsChange/onTodosChange signal.
   */
  function broadcastEachClient(key: string, computeData: (characterId: string) => unknown) {
    for (const client of clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const character = characterByClient.get(client);
      if (!character) continue;
      client.send(JSON.stringify({ type: "state", key, data: computeData(character.id) }));
    }
  }

  function sendSettings(ws: WebSocket, deviceId: string) {
    ws.send(JSON.stringify({ type: "state", key: "settings", data: getDeviceSettings(deviceId) }));
  }

  onGoalsChange(() => broadcastEachClient("goals", (characterId) => getGoals(characterId)));
  onTodosChange(() => broadcastEachClient("todos", (characterId) => getTodos(characterId)));

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const character = getCharacterBySecret(url.searchParams.get("secret") ?? "");
    if (!character) {
      ws.close(4001, "unauthorized");
      return;
    }
    characterCache.set(character.id, character);

    // One id per browser/device (generated client-side, stored in
    // localStorage) — settings are scoped to it so a phone and a Mac can
    // have different zoom/theme without one overwriting the other.
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) {
      ws.close(4002, "missing deviceId");
      return;
    }

    // Checked before this client is registered/sent anything — if it
    // fixes something, the broadcast it fires reaches any OTHER already-
    // connected device of this same character, and this new client just
    // gets the already-correct value in its own initial "status" send
    // below, no separate broadcast needed for it.
    await stopIfOrphaned(character).catch((err) => console.error("[rpc] stopIfOrphaned on connect failed", err));

    deviceIdByClient.set(ws, deviceId);
    characterByClient.set(ws, character);

    clients.add(ws);
    ws.send(JSON.stringify({ type: "state", key: "character", data: { id: character.id, name: character.name, spriteName: character.spriteName } }));
    ws.send(JSON.stringify({ type: "state", key: "goals", data: getGoals(character.id) }));
    ws.send(JSON.stringify({ type: "state", key: "todos", data: getTodos(character.id) }));
    ws.send(JSON.stringify({ type: "state", key: "status", data: currentStatus(character.awBucketId) }));
    // Every character's current activity, not just this connection's own
    // — see computeAllStatuses's own comment.
    ws.send(JSON.stringify({ type: "state", key: "allStatuses", data: computeAllStatuses() }));
    // Global registry, same for every character (see this module's own
    // comment on character scoping) — sent once on connect; an admin-tool
    // edit takes effect on the next reconnect, not live mid-session.
    ws.send(JSON.stringify({ type: "state", key: "activities", data: getActivities() }));
    ws.send(JSON.stringify({ type: "state", key: "objectTypes", data: getObjectTypes() }));
    ws.send(JSON.stringify({ type: "state", key: "roomSpecs", data: getRoomSpecs() }));
    ws.send(JSON.stringify({ type: "state", key: "floors", data: getFloors() }));
    sendSettings(ws, deviceId);

    ws.on("close", () => {
      clients.delete(ws);
      deviceIdByClient.delete(ws);
      characterByClient.delete(ws);
    });

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "command" && msg.name === "updateSettings") {
        try {
          const patch = msg.args as Partial<DeviceSettings>;
          updateDeviceSettings(deviceId, patch);
          sendSettings(ws, deviceId);
        } catch (err) {
          console.error("[rpc] updateSettings failed", err);
        }
        return;
      }

      if (msg.type === "command") {
        const handler = commands[msg.name];
        if (!handler) {
          console.error(`[rpc] unknown command: ${msg.name}`);
          return;
        }
        try {
          await handler(character.id, msg.args ?? {});
          if (msg.name === "startActivity" || msg.name === "stopActivity") {
            broadcastToCharacter(character.id, "status", currentStatus(character.awBucketId));
            broadcastAllStatuses();
            // Only published characters reach val.town/the viewer — see
            // server/characters.ts's own comment on publishToViewer.
            if (character.publishToViewer) {
              pushStatus(character.id).catch((err) => console.error("[rpc] pushStatus after activity change failed", err));
            }
          }
        } catch (err) {
          console.error(`[rpc] command ${msg.name} failed`, err);
        }
        return;
      }

      if (msg.type === "query") {
        const handler = queries[msg.name];
        if (!handler) {
          console.error(`[rpc] unknown query: ${msg.name}`);
          ws.send(JSON.stringify({ type: "queryResult", requestId: msg.requestId, error: "unknown query" }));
          return;
        }
        try {
          const data = await handler(character.id, msg.args ?? {});
          ws.send(JSON.stringify({ type: "queryResult", requestId: msg.requestId, data }));
        } catch (err) {
          console.error(`[rpc] query ${msg.name} failed`, err);
          ws.send(JSON.stringify({ type: "queryResult", requestId: msg.requestId, error: (err as Error).message }));
        }
        return;
      }
    });
  });
}
