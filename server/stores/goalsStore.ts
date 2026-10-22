import { db } from "../db";
import { Goal } from "../../src/goals/types";

interface GoalRow {
  id: string;
  character_id: string;
  activity_label: string;
  target_minutes: number;
  recurrence_json: string;
  skip_dates_json: string | null;
  created_at: string | null;
  streak_start_date: string | null;
  highest_streak: number | null;
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    characterId: row.character_id,
    activityLabel: row.activity_label,
    targetMinutes: row.target_minutes,
    recurrence: JSON.parse(row.recurrence_json),
    skipDates: row.skip_dates_json ? JSON.parse(row.skip_dates_json) : undefined,
    createdAt: row.created_at ?? undefined,
    streakStartDate: row.streak_start_date ?? undefined,
    highestStreak: row.highest_streak ?? undefined,
  };
}

/**
 * {load, save} shape matching src/lib/jsonFileStore.ts's createJsonFileStore
 * exactly, so this is a drop-in store for createPersistedState — goals is
 * small enough that "rewrite the whole table on save" (same spirit as
 * rewriting the whole JSON file) is simpler than diffing, and keeps the
 * business logic above this (addGoal/updateGoal/etc in server/goals.ts)
 * unaware it's talking to SQLite at all.
 */
export const goalsStore = {
  async load(): Promise<Goal[]> {
    const rows = db.prepare("SELECT * FROM goals").all() as GoalRow[];
    return rows.map(rowToGoal);
  },
  async save(goals: Goal[]): Promise<void> {
    const insert = db.prepare(`
      INSERT INTO goals (id, character_id, activity_label, target_minutes, recurrence_json, skip_dates_json, created_at, streak_start_date, highest_streak)
      VALUES (@id, @characterId, @activityLabel, @targetMinutes, @recurrenceJson, @skipDatesJson, @createdAt, @streakStartDate, @highestStreak)
    `);
    const tx = db.transaction((goals: Goal[]) => {
      db.prepare("DELETE FROM goals").run();
      for (const g of goals) {
        insert.run({
          id: g.id,
          characterId: g.characterId,
          activityLabel: g.activityLabel,
          targetMinutes: g.targetMinutes,
          recurrenceJson: JSON.stringify(g.recurrence),
          skipDatesJson: g.skipDates ? JSON.stringify(g.skipDates) : null,
          createdAt: g.createdAt ?? null,
          streakStartDate: g.streakStartDate ?? null,
          highestStreak: g.highestStreak ?? null,
        });
      }
    });
    tx(goals);
  },
};
