import { createPersistedState } from "../lib/persistedState";
import { localDateString } from "./recurrence";
import { goalsFileStore } from "./store";
import { Goal, Recurrence } from "./types";

const goalsState = createPersistedState(goalsFileStore.load, goalsFileStore.save);

export const initGoalsState = goalsState.init;
export const getGoals = goalsState.get;
/** Called after every mutation — subscribe to keep a view in sync with the shared list. */
export const onGoalsChange = goalsState.onChange;

export function todayDateString(): string {
  return localDateString(new Date());
}

function recurrenceEquals(a: Recurrence, b: Recurrence): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "once" && b.type === "once") return a.date === b.date;
  if (a.type === "weekly" && b.type === "weekly") {
    return a.daysOfWeek.length === b.daysOfWeek.length && a.daysOfWeek.every((d) => b.daysOfWeek.includes(d));
  }
  if (a.type === "monthly" && b.type === "monthly") {
    return a.occurrence === b.occurrence && a.dayOfWeek === b.dayOfWeek;
  }
  return false;
}

export async function addGoal(activityLabel: string, targetMinutes: number, recurrence: Recurrence) {
  const goals = getGoals();
  // Re-adding the same activity on the same schedule shouldn't create a
  // second entry — extend the existing goal's target instead, which also
  // naturally un-checks it if it had already been marked done.
  const existing = goals.find(
    (g) => g.activityLabel === activityLabel && recurrenceEquals(g.recurrence, recurrence),
  );
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

export async function skipGoalToday(goal: Goal) {
  goal.skipDates = [...(goal.skipDates ?? []), todayDateString()];
  await goalsState.persist(getGoals());
}

export async function unskipGoalToday(goal: Goal) {
  goal.skipDates = (goal.skipDates ?? []).filter((d) => d !== todayDateString());
  await goalsState.persist(getGoals());
}

export async function updateGoal(id: string, targetMinutes: number, recurrence: Recurrence) {
  const goal = getGoals().find((g) => g.id === id);
  if (!goal) return;
  goal.targetMinutes = targetMinutes;
  goal.recurrence = recurrence;
  await goalsState.persist(getGoals());
}
