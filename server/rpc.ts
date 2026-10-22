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
import { Character, getCharacterBySecret } from "./characters";
import { getWorkoutsForDate } from "./workouts";
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

const queries: Record<string, (characterId: string, args: any) => Promise<unknown>> = {
  getGoalProgressForDate: (characterId, { dateStr }) => getGoalProgressForDate(characterId, dateStr),
  getTodayMinutesByLabel: (characterId) => getTodayMinutesByLabel(characterId),
  getActivityStatsForDate: (characterId, { dateStr }) => getActivityStatsForDate(characterId, dateStr),
  getActivityStats: (characterId) => getActivityStats(characterId),
  computePeriodStats: (characterId, { startIso, endIso }) => computePeriodStats(characterId, new Date(startIso), new Date(endIso)),
  getTodayStreaksByGoalId: async (characterId) => getTodayStreaksByGoalId(characterId),
  getCurrentActivity: async (characterId) => getCurrentActivity(bucketIdFor(characterId)),
  getGoalHistory: async (characterId) => getAllHistory(characterId),
  historyForGoal: async (characterId, { goalId }) => historyForGoal(characterId, goalId),
  getWorkoutsForDate: async (characterId, { dateStr }) => getWorkoutsForDate(characterId, dateStr),
  fetchMessages: () => fetchMessages(),
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

export function setupRpc(wss: WebSocketServer): void {
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

  wss.on("connection", (ws, req) => {
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
    deviceIdByClient.set(ws, deviceId);
    characterByClient.set(ws, character);

    clients.add(ws);
    ws.send(JSON.stringify({ type: "state", key: "character", data: { id: character.id, name: character.name } }));
    ws.send(JSON.stringify({ type: "state", key: "goals", data: getGoals(character.id) }));
    ws.send(JSON.stringify({ type: "state", key: "todos", data: getTodos(character.id) }));
    ws.send(JSON.stringify({ type: "state", key: "status", data: currentStatus(character.awBucketId) }));
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
            // val.town/the public viewer only ever show one character
            // (Jacqueline) for now — see server/broadcast.ts's own comment.
            if (character.name === "Jacqueline") {
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
