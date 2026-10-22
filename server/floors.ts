import { db } from "./db";
import { Floor, STATIC_FLOORS } from "../src/scene/floors";

interface FloorRow {
  level: number;
  label: string;
  base_room_id: string;
}

function rowToFloor(row: FloorRow): Floor {
  return { level: row.level, label: row.label, baseRoomId: row.base_room_id };
}

export function getFloors(): Floor[] {
  return (db.prepare("SELECT level, label, base_room_id FROM floors ORDER BY level DESC").all() as FloorRow[]).map(rowToFloor);
}

/** One-time seed from scene/floors.ts's STATIC_FLOORS — only runs if the table is still empty, so an admin-tool edit is never clobbered by a later restart. */
export function seedFloorsIfEmpty(): void {
  const { n } = db.prepare("SELECT COUNT(*) as n FROM floors").get() as { n: number };
  if (n > 0) return;
  const insert = db.prepare("INSERT INTO floors (level, label, base_room_id) VALUES (@level, @label, @baseRoomId)");
  const tx = db.transaction(() => {
    for (const f of STATIC_FLOORS) insert.run({ level: f.level, label: f.label, baseRoomId: f.baseRoomId });
  });
  tx();
}

export function createFloor(floor: Floor): void {
  db.prepare("INSERT INTO floors (level, label, base_room_id) VALUES (@level, @label, @baseRoomId)").run({
    level: floor.level,
    label: floor.label,
    baseRoomId: floor.baseRoomId,
  });
}

export function updateFloor(level: number, floor: { label: string; baseRoomId: string }): void {
  db.prepare("UPDATE floors SET label = @label, base_room_id = @baseRoomId WHERE level = @level").run({
    level,
    label: floor.label,
    baseRoomId: floor.baseRoomId,
  });
}

export function deleteFloor(level: number): void {
  db.prepare("DELETE FROM floors WHERE level = ?").run(level);
}
