import { createPersistedState } from "../lib/persistedState";
import { localDateString } from "./recurrence";
import { goalsFileStore } from "./store";
import { Goal, Recurrence } from "./types";

// jsonFileStore has no schema-version mechanism, so goals saved under the
// old single-occurrence monthly shape ({ occurrence: 1|2|3|4|"last" })
// need converting to the new multi-occurrence one ({ occurrences: [...] })
// on every load. Self-heals on disk the next time goals are saved for any
// reason — no explicit write-back needed here.
function migrateGoals(goals: Goal[]): Goal[] {
  return goals.map((goal) => {
    const recurrence = goal.recurrence as Recurrence & { occurrence?: 1 | 2 | 3 | 4 | "last" };
    if (recurrence.type !== "monthly" || !("occurrence" in recurrence)) return goal;
    const { occurrence, ...rest } = recurrence;
    return { ...goal, recurrence: { ...rest, occurrences: [occurrence] } as Recurrence };
  });
}

const goalsState = createPersistedState(
  async () => migrateGoals(await goalsFileStore.load()),
  goalsFileStore.save,
);

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

// Changing activityLabel on a goal that already has goalHistory.ts entries
// leaves those old entries attributed to the old label — the history log
// records whatever label was current at settle-time, not a live reference
// to this goal. Same thing you'd get from deleting the goal and adding a
// new one for a different activity instead, so not a reason to disallow it.
export async function updateGoal(id: string, activityLabel: string, targetMinutes: number, recurrence: Recurrence) {
  const goal = getGoals().find((g) => g.id === id);
  if (!goal) return;
  goal.activityLabel = activityLabel;
  goal.targetMinutes = targetMinutes;
  goal.recurrence = recurrence;
  await goalsState.persist(getGoals());
}
