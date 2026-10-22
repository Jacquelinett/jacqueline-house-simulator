import { db } from "./db";
import { ActivityDef, STATIC_ACTIVITIES } from "../src/scene/activities";

interface ActivityRow {
  id: number;
  label: string;
  color: number;
}

function rowToActivity(row: ActivityRow): ActivityDef {
  return { id: row.id, label: row.label, color: row.color };
}

export function getActivities(): ActivityDef[] {
  return (db.prepare("SELECT id, label, color FROM activities ORDER BY label").all() as ActivityRow[]).map(rowToActivity);
}

/** One-time seed from scene/activities.ts's STATIC_ACTIVITIES — only runs if the table is still empty, so an admin-tool edit is never clobbered by a later restart. */
export function seedActivitiesIfEmpty(): void {
  const { n } = db.prepare("SELECT COUNT(*) as n FROM activities").get() as { n: number };
  if (n > 0) return;
  const insert = db.prepare("INSERT INTO activities (id, label, color) VALUES (?, ?, ?)");
  const tx = db.transaction(() => {
    for (const a of Object.values(STATIC_ACTIVITIES)) insert.run(a.id, a.label, a.color);
  });
  tx();
}

/** id omitted from the INSERT — SQLite auto-assigns the next INTEGER PRIMARY KEY. */
export function createActivity(label: string, color: number): ActivityDef {
  const { lastInsertRowid } = db.prepare("INSERT INTO activities (label, color) VALUES (?, ?)").run(label, color);
  return { id: Number(lastInsertRowid), label, color };
}

export function updateActivity(id: number, label: string, color: number): void {
  db.prepare("UPDATE activities SET label = ?, color = ? WHERE id = ?").run(label, color, id);
}

export function deleteActivity(id: number): void {
  db.prepare("DELETE FROM activities WHERE id = ?").run(id);
}
