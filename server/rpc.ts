import { WebSocket, WebSocketServer } from "ws";
import { getCurrentActivity, startActivity, stopActivity } from "../src/aw/client";
import { getActivityStats, getActivityStatsForDate } from "../src/dashboard/stats";
import {
  addGoal,
  deleteGoal,
  getGoals,
  onGoalsChange,
  skipGoalToday,
  unskipGoalToday,
  updateGoal,
} from "./goals";
import { getTodayStreaksByGoalId } from "./goalHistory";
import { getGoalProgressForDate, getTodayMinutesByLabel } from "./progress";
import { computeFixedPeriodStats, computePeriodStats } from "./periodStats";
import { addTodo, deleteTodo, getTodos, onTodosChange, toggleTodo } from "./todos";

/**
 * One WebSocket connection per client carries everything — commands
 * (fire-and-forget writes, server rebroadcasts the affected state to all
 * clients after applying), queries (request/response, correlated by
 * requestId), and unsolicited state broadcasts on change. See the
 * migration plan's "RPC protocol" section for the shape. Command/query
 * names map 1:1 onto the functions above via these two dispatch tables.
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
};

function currentStatus() {
  const current = getCurrentActivity();
  return { activityLabel: current?.label ?? null, startedAt: current?.startedAt.toISOString() ?? null };
}

export function setupRpc(wss: WebSocketServer, lanSecret: string | null): void {
  const clients = new Set<WebSocket>();

  function broadcast(key: string, data: unknown) {
    const message = JSON.stringify({ type: "state", key, data });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
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

    clients.add(ws);
    ws.send(JSON.stringify({ type: "state", key: "goals", data: getGoals() }));
    ws.send(JSON.stringify({ type: "state", key: "todos", data: getTodos() }));
    ws.send(JSON.stringify({ type: "state", key: "status", data: currentStatus() }));

    ws.on("close", () => clients.delete(ws));

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
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
