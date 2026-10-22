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
import { computeFixedPeriodStats, computePeriodStats } from "./periodStats";
import { addTodo, deleteTodo, getTodos, onTodosChange, toggleTodo } from "./todos";
import { deleteMessage, fetchMessages, getBroadcastHealthInfo, pushStatus } from "./broadcast";
import { getDeviceSettings, updateDeviceSettings } from "./deviceSettings";

/**
 * One WebSocket connection per client carries everything — commands
 * (fire-and-forget writes, server rebroadcasts the affected state to all
 * clients after applying), queries (request/response, correlated by
 * requestId), and unsolicited state broadcasts on change. See the
 * migration plan's "RPC protocol" section for the shape. Command/query
 * names map 1:1 onto the functions above via these two dispatch tables.
 * `updateSettings` is handled separately below (not in this table) since
 * it needs the connection's own deviceId, which the other commands don't.
 */
const commands: Record<string, (args: any) => Promise<void>> = {
  startActivity: ({ label }) => startActivity(label),
  stopActivity: () => stopActivity(),
  addGoal: ({ activityLabel, targetMinutes, recurrence }) => addGoal(activityLabel, targetMinutes, recurrence),
  updateGoal: ({ id, activityLabel, targetMinutes, recurrence }) => updateGoal(id, activityLabel, targetMinutes, recurrence),
  deleteGoal: ({ id }) => deleteGoal(id),
  skipGoalToday: ({ goalId }) => skipGoalToday(goalId),
  unskipGoalToday: ({ goalId }) => unskipGoalToday(goalId),
  addTodo: ({ text }) => addTodo(text),
  toggleTodo: ({ id }) => toggleTodo(id),
  deleteTodo: ({ id }) => deleteTodo(id),
  deleteMessage: ({ id }) => deleteMessage(id),
};

const queries: Record<string, (args: any) => Promise<unknown>> = {
  getGoalProgressForDate: ({ dateStr }) => getGoalProgressForDate(dateStr),
  getTodayMinutesByLabel: () => getTodayMinutesByLabel(),
  getActivityStatsForDate: ({ dateStr }) => getActivityStatsForDate(dateStr),
  getActivityStats: () => getActivityStats(),
  computeFixedPeriodStats: () => computeFixedPeriodStats(),
  computePeriodStats: ({ startIso, endIso }) => computePeriodStats(new Date(startIso), new Date(endIso)),
  getTodayStreaksByGoalId: async () => getTodayStreaksByGoalId(),
  getCurrentActivity: async () => getCurrentActivity(),
  getGoalHistory: async () => getAllHistory(),
  historyForGoal: async ({ goalId }) => historyForGoal(goalId),
  fetchMessages: () => fetchMessages(),
  getBroadcastHealth: async () => getBroadcastHealthInfo(),
};

function currentStatus() {
  const current = getCurrentActivity();
  return { activityLabel: current?.label ?? null, startedAt: current?.startedAt.toISOString() ?? null };
}

export function setupRpc(wss: WebSocketServer, lanSecret: string | null): void {
  const clients = new Set<WebSocket>();
  const deviceIdByClient = new Map<WebSocket, string>();

  function broadcast(key: string, data: unknown) {
    const message = JSON.stringify({ type: "state", key, data });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  function sendSettings(ws: WebSocket, deviceId: string) {
    ws.send(JSON.stringify({ type: "state", key: "settings", data: getDeviceSettings(deviceId) }));
  }

  // Re-broadcast whenever goals/todos change for any reason (an RPC
  // command here, or settleGoalHistory's own periodic mutation) — one
  // notification path instead of each command handler remembering to
  // broadcast after itself.
  onGoalsChange(() => broadcast("goals", getGoals()));
  onTodosChange(() => broadcast("todos", getTodos()));

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (lanSecret && url.searchParams.get("secret") !== lanSecret) {
      ws.close(4001, "unauthorized");
      return;
    }

    // One id per browser/device (generated client-side, stored in
    // localStorage) — settings are scoped to it so a phone and a Mac can
    // have different zoom/theme without one overwriting the other.
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) {
      ws.close(4002, "missing deviceId");
      return;
    }
    deviceIdByClient.set(ws, deviceId);

    clients.add(ws);
    ws.send(JSON.stringify({ type: "state", key: "goals", data: getGoals() }));
    ws.send(JSON.stringify({ type: "state", key: "todos", data: getTodos() }));
    ws.send(JSON.stringify({ type: "state", key: "status", data: currentStatus() }));
    sendSettings(ws, deviceId);

    ws.on("close", () => {
      clients.delete(ws);
      deviceIdByClient.delete(ws);
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
          await handler(msg.args ?? {});
          if (msg.name === "startActivity" || msg.name === "stopActivity") {
            broadcast("status", currentStatus());
            // Pushed on every activity change (not just the hourly timer)
            // so a viewer isn't stuck showing stale data between pushes —
            // same reasoning main.ts's onActivityChange callback had.
            pushStatus().catch((err) => console.error("[rpc] pushStatus after activity change failed", err));
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
          const data = await handler(msg.args ?? {});
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
