import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.join(import.meta.dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "houseSimulator.db"));
db.pragma("journal_mode = WAL");

/**
 * Schema migration, run once at startup — `CREATE TABLE IF NOT EXISTS` is a
 * no-op once a table already exists, same gotcha val.town's own
 * `ensureSchema()` has (see CLAUDE.md's "Schema migration gotcha"): it
 * won't retroactively add a column to an existing table. Any future
 * column addition needs an explicit `ALTER TABLE ... ADD COLUMN`
 * (`.catch`-safe — these throw if the column already exists) alongside
 * updating the `CREATE TABLE` statement here for fresh installs.
 */
export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      activity_label TEXT NOT NULL,
      target_minutes INTEGER NOT NULL,
      recurrence_json TEXT NOT NULL,
      skip_dates_json TEXT,
      created_at TEXT,
      streak_start_date TEXT,
      highest_streak INTEGER
    );

    CREATE TABLE IF NOT EXISTS goal_history (
      goal_id TEXT NOT NULL,
      date TEXT NOT NULL,
      activity_label TEXT NOT NULL,
      target_minutes INTEGER NOT NULL,
      actual_minutes REAL NOT NULL,
      outcome TEXT NOT NULL,
      PRIMARY KEY (goal_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_history_date ON goal_history(date);

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      done INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_settings (
      device_id TEXT PRIMARY KEY,
      scale REAL NOT NULL,
      theme TEXT NOT NULL,
      dev_mode INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS server_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      broadcast_url TEXT,
      broadcast_secret TEXT,
      lan_secret TEXT
    );
  `);
}
