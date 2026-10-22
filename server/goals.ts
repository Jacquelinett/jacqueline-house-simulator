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
 *
 * One shared in-memory array holds every character's goals together (same
 * as the underlying table) — every exported function below takes a
 * characterId and filters/tags/authorizes against it, rather than each
 * character getting a separate createPersistedState instance. A mutate-by-id
 * function (deleteGoal/skipGoalToday/...) only ever matches a row that's
 * BOTH the given id AND the given characterId, so a connection can't affect
 * another character's goal even by guessing its id.
 */
const goalsState = createPersistedState(goalsStore.load, goalsStore.save);

export const initGoalsState = goalsState.init;
export const onGoalsChange = goalsState.onChange;

export function getGoals(characterId: string): Goal[] {
  return goalsState.get().filter((g) => g.characterId === characterId);
}

/** Every character's goals together — for cross-character server-internal work only (settlement, broadcasting each connection its own slice), never exposed to a client directly. */
export function getAllGoals(): Goal[] {
  return goalsState.get();
}

export function todayDateString(): string {
  return localDateString(new Date());
}

export async function persistGoals(): Promise<void> {
  await goalsState.persist(goalsState.get());
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

export async function addGoal(characterId: string, activityLabel: string, targetMinutes: number, recurrence: Recurrence) {
  const allGoals = goalsState.get();
  const existing = allGoals.find(
    (g) => g.characterId === characterId && g.activityLabel === activityLabel && recurrenceEquals(g.recurrence, recurrence),
  );
  if (existing) {
    existing.targetMinutes += targetMinutes;
    await goalsState.persist(allGoals);
  } else {
    await goalsState.persist([
      ...allGoals,
      { id: crypto.randomUUID(), characterId, activityLabel, targetMinutes, recurrence, createdAt: todayDateString() },
    ]);
  }
}

export async function deleteGoal(characterId: string, id: string) {
  await goalsState.persist(goalsState.get().filter((g) => !(g.id === id && g.characterId === characterId)));
}

export async function skipGoalToday(characterId: string, goalId: string) {
  const goal = goalsState.get().find((g) => g.id === goalId && g.characterId === characterId);
  if (!goal) return;
  goal.skipDates = [...(goal.skipDates ?? []), todayDateString()];
  await goalsState.persist(goalsState.get());
}

export async function unskipGoalToday(characterId: string, goalId: string) {
  const goal = goalsState.get().find((g) => g.id === goalId && g.characterId === characterId);
  if (!goal) return;
  goal.skipDates = (goal.skipDates ?? []).filter((d) => d !== todayDateString());
  await goalsState.persist(goalsState.get());
}

export async function updateGoal(
  characterId: string,
  id: string,
  activityLabel: string,
  targetMinutes: number,
  recurrence: Recurrence,
) {
  const goal = goalsState.get().find((g) => g.id === id && g.characterId === characterId);
  if (!goal) return;
  goal.activityLabel = activityLabel;
  goal.targetMinutes = targetMinutes;
  goal.recurrence = recurrence;
  await goalsState.persist(goalsState.get());
}

export type { Goal, Recurrence };
