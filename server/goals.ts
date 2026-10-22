import { createPersistedState } from "../src/lib/persistedState";
import { localDateString } from "../src/goals/recurrence";
import { Goal, Recurrence } from "../src/goals/types";
import { goalsStore } from "./stores/goalsStore";

/**
 * Server-side home for what was src/goals/state.ts's business logic (the
 * storage was the only Tauri-coupled part there — this swaps it for
 * goalsStore's SQLite-backed {load, save}, otherwise unchanged). The
 * client-side src/goals/state.ts becomes a thin RPC wrapper over this once
 * the frontend is rewired (see the migration plan) — until then this is a
 * deliberate temporary duplicate, not a permanent one.
 */
const goalsState = createPersistedState(goalsStore.load, goalsStore.save);

export const initGoalsState = goalsState.init;
export const getGoals = goalsState.get;
export const onGoalsChange = goalsState.onChange;

export function todayDateString(): string {
  return localDateString(new Date());
}

export async function persistGoals(): Promise<void> {
  await goalsState.persist(getGoals());
}

function recurrenceEquals(a: Recurrence, b: Recurrence): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "once" && b.type === "once") return a.date === b.date;
  if (a.type === "daily") return true;
  if (a.type === "weekly" && b.type === "weekly") {
    return a.daysOfWeek.length === b.daysOfWeek.length && a.daysOfWeek.every((d) => b.daysOfWeek.includes(d));
  }
  if (a.type === "monthly" && b.type === "monthly") {
    return (
      a.dayOfWeek === b.dayOfWeek &&
      a.occurrences.length === b.occurrences.length &&
      a.occurrences.every((occ) => b.occurrences.includes(occ))
    );
  }
  return false;
}

export async function addGoal(activityLabel: string, targetMinutes: number, recurrence: Recurrence) {
  const goals = getGoals();
  const existing = goals.find((g) => g.activityLabel === activityLabel && recurrenceEquals(g.recurrence, recurrence));
  if (existing) {
    existing.targetMinutes += targetMinutes;
    await goalsState.persist(goals);
  } else {
    await goalsState.persist([
      ...goals,
      { id: crypto.randomUUID(), activityLabel, targetMinutes, recurrence, createdAt: todayDateString() },
    ]);
  }
}

export async function deleteGoal(id: string) {
  await goalsState.persist(getGoals().filter((g) => g.id !== id));
}

export async function skipGoalToday(goalId: string) {
  const goal = getGoals().find((g) => g.id === goalId);
  if (!goal) return;
  goal.skipDates = [...(goal.skipDates ?? []), todayDateString()];
  await goalsState.persist(getGoals());
}

export async function unskipGoalToday(goalId: string) {
  const goal = getGoals().find((g) => g.id === goalId);
  if (!goal) return;
  goal.skipDates = (goal.skipDates ?? []).filter((d) => d !== todayDateString());
  await goalsState.persist(getGoals());
}

export async function updateGoal(id: string, activityLabel: string, targetMinutes: number, recurrence: Recurrence) {
  const goal = getGoals().find((g) => g.id === id);
  if (!goal) return;
  goal.activityLabel = activityLabel;
  goal.targetMinutes = targetMinutes;
  goal.recurrence = recurrence;
  await goalsState.persist(getGoals());
}

export type { Goal, Recurrence };
