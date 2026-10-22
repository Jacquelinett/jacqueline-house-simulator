import { db } from "../db";
import { GoalHistoryEntry } from "../../src/goals/history";

interface HistoryRow {
  goal_id: string;
  date: string;
  activity_label: string;
  target_minutes: number;
  actual_minutes: number;
  outcome: GoalHistoryEntry["outcome"];
}

function rowToEntry(row: HistoryRow): GoalHistoryEntry {
  return {
    goalId: row.goal_id,
    date: row.date,
    activityLabel: row.activity_label,
    targetMinutes: row.target_minutes,
    actualMinutes: row.actual_minutes,
    outcome: row.outcome,
  };
}

/**
 * Unlike goalsStore/todosStore, this is NOT a {load, save} blob — goal
 * history is unbounded and append-only, so it gets real indexed queries
 * instead of "load everything into memory, filter in JS" the way the old
 * Tauri-fs-backed version worked. getAll() still exists for the one or two
 * callers that genuinely want everything (All-Time stats); everything
 * else should prefer getInRange().
 */
export const goalHistoryStore = {
  getAll(): GoalHistoryEntry[] {
    return (db.prepare("SELECT * FROM goal_history").all() as HistoryRow[]).map(rowToEntry);
  },

  getInRange(startDateStr: string, endDateStrExclusive: string): GoalHistoryEntry[] {
    return (
      db
        .prepare("SELECT * FROM goal_history WHERE date >= ? AND date < ? ORDER BY date")
        .all(startDateStr, endDateStrExclusive) as HistoryRow[]
    ).map(rowToEntry);
  },

  getForGoal(goalId: string): GoalHistoryEntry[] {
    return (db.prepare("SELECT * FROM goal_history WHERE goal_id = ? ORDER BY date").all(goalId) as HistoryRow[]).map(
      rowToEntry,
    );
  },

  lastSettledDateFor(goalId: string): string | null {
    const row = db.prepare("SELECT MAX(date) as maxDate FROM goal_history WHERE goal_id = ?").get(goalId) as {
      maxDate: string | null;
    };
    return row.maxDate;
  },

  insertMany(entries: GoalHistoryEntry[]): void {
    if (entries.length === 0) return;
    const insert = db.prepare(`
      INSERT INTO goal_history (goal_id, date, activity_label, target_minutes, actual_minutes, outcome)
      VALUES (@goalId, @date, @activityLabel, @targetMinutes, @actualMinutes, @outcome)
    `);
    const tx = db.transaction((entries: GoalHistoryEntry[]) => {
      for (const e of entries) insert.run(e);
    });
    tx(entries);
  },
};
