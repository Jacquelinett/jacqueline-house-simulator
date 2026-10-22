import { Goal, Recurrence } from "./types";
import { getGoals as remoteGetGoals, onGoalsChange as remoteOnGoalsChange, sendCommand } from "../client/remoteState";

/**
 * Thin wrapper over the WebSocket remote-state layer — same exported
 * names/signatures this file always had, so callers (goals/panel.ts,
 * goals/manageModal.ts, dashboard/panel.ts, ...) didn't need to change at
 * all. The real logic (recurrenceEquals, migrateGoals, actually mutating
 * goals.json) now lives server-side in server/goals.ts; this just sends
 * commands and lets the server's `goals` state broadcast (which fires
 * after every change, including settleGoalHistory's own streak updates)
 * drive re-renders.
 */
export const getGoals = remoteGetGoals;
export const onGoalsChange = remoteOnGoalsChange;

export async function addGoal(activityLabel: string, targetMinutes: number, recurrence: Recurrence): Promise<void> {
  sendCommand("addGoal", { activityLabel, targetMinutes, recurrence });
}

export async function deleteGoal(id: string): Promise<void> {
  sendCommand("deleteGoal", { id });
}

export async function skipGoalToday(goal: Goal): Promise<void> {
  sendCommand("skipGoalToday", { goalId: goal.id });
}

export async function unskipGoalToday(goal: Goal): Promise<void> {
  sendCommand("unskipGoalToday", { goalId: goal.id });
}

export async function updateGoal(
  id: string,
  activityLabel: string,
  targetMinutes: number,
  recurrence: Recurrence,
): Promise<void> {
  sendCommand("updateGoal", { id, activityLabel, targetMinutes, recurrence });
}
