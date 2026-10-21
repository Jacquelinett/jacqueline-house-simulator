import { localDateString } from "./recurrence";
import { loadGoals, saveGoals } from "./store";
import { Goal, Recurrence } from "./types";

let goals: Goal[] = [];
const listeners = new Set<() => void>();

export async function initGoalsState(): Promise<void> {
  goals = await loadGoals();
}

export function getGoals(): Goal[] {
  return goals;
}

/** Called after every mutation — subscribe to keep a view in sync with the shared list. */
export function onGoalsChange(cb: () => void): void {
  listeners.add(cb);
}

export function todayDateString(): string {
  return localDateString(new Date());
}

async function persist() {
  await saveGoals(goals);
  for (const cb of listeners) cb();
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
  // Re-adding the same activity on the same schedule shouldn't create a
  // second entry — extend the existing goal's target instead, which also
  // naturally un-checks it if it had already been marked done.
  const existing = goals.find(
    (g) => g.activityLabel === activityLabel && recurrenceEquals(g.recurrence, recurrence),
  );
  if (existing) {
    existing.targetMinutes += targetMinutes;
  } else {
    goals.push({ id: crypto.randomUUID(), activityLabel, targetMinutes, recurrence });
  }
  await persist();
}

export async function deleteGoal(id: string) {
  goals = goals.filter((g) => g.id !== id);
  await persist();
}

export async function skipGoalToday(goal: Goal) {
  goal.skipDates = [...(goal.skipDates ?? []), todayDateString()];
  await persist();
}

export async function unskipGoalToday(goal: Goal) {
  goal.skipDates = (goal.skipDates ?? []).filter((d) => d !== todayDateString());
  await persist();
}

export async function updateGoal(id: string, targetMinutes: number, recurrence: Recurrence) {
  const goal = goals.find((g) => g.id === id);
  if (!goal) return;
  goal.targetMinutes = targetMinutes;
  goal.recurrence = recurrence;
  await persist();
}
