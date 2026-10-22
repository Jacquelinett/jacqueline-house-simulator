import { db } from "./db";
import { ObjectAction, ObjectTypeDef, SpriteLayer, STATIC_OBJECT_TYPES } from "../src/scene/rooms";

interface TypeRow {
  id: number;
  name: string;
  below_json: string | null;
  overlay_json: string | null;
  above_json: string | null;
  width: number;
  height: number;
  actions_json: string | null;
  anchor_x: number | null;
  anchor_y: number | null;
}

function rowToType(row: TypeRow): ObjectTypeDef {
  return {
    id: row.id,
    name: row.name,
    width: row.width,
    height: row.height,
    below: row.below_json ? (JSON.parse(row.below_json) as SpriteLayer[]) : undefined,
    overlay: row.overlay_json ? (JSON.parse(row.overlay_json) as SpriteLayer[]) : undefined,
    above: row.above_json ? (JSON.parse(row.above_json) as SpriteLayer[]) : undefined,
    actions: row.actions_json ? (JSON.parse(row.actions_json) as ObjectAction[]) : undefined,
    anchorX: row.anchor_x ?? undefined,
    anchorY: row.anchor_y ?? undefined,
  };
}

/** Keyed by id (object_types.id), matching the shape client-side setObjectTypes() expects. */
export function getObjectTypes(): Record<string, ObjectTypeDef> {
  const rows = db.prepare("SELECT * FROM object_types").all() as TypeRow[];
  const result: Record<string, ObjectTypeDef> = {};
  for (const row of rows) result[row.id] = rowToType(row);
  return result;
}

/** One-time seed from scene/rooms.ts's STATIC_OBJECT_TYPES — explicit ids matching that registry's own literal ids, so existing STATIC_ROOM_SPECS placements (type: STATIC_OBJECT_TYPES.piano.id) resolve against the seeded rows unchanged. */
export function seedObjectTypesIfEmpty(): void {
  const { n } = db.prepare("SELECT COUNT(*) as n FROM object_types").get() as { n: number };
  if (n > 0) return;
  const insert = db.prepare(`
    INSERT INTO object_types (id, name, below_json, overlay_json, above_json, width, height, actions_json, anchor_x, anchor_y)
    VALUES (@id, @name, @belowJson, @overlayJson, @aboveJson, @width, @height, @actionsJson, @anchorX, @anchorY)
  `);
  const tx = db.transaction(() => {
    for (const type of Object.values(STATIC_OBJECT_TYPES) as ObjectTypeDef[]) {
      insert.run({
        id: type.id,
        name: type.name,
        belowJson: type.below ? JSON.stringify(type.below) : null,
        overlayJson: type.overlay ? JSON.stringify(type.overlay) : null,
        aboveJson: type.above ? JSON.stringify(type.above) : null,
        width: type.width,
        height: type.height,
        actionsJson: type.actions ? JSON.stringify(type.actions) : null,
        anchorX: type.anchorX ?? null,
        anchorY: type.anchorY ?? null,
      });
    }
  });
  tx();
}

/** `def.id` (if present) is ignored — id omitted from the INSERT so SQLite auto-assigns the next INTEGER PRIMARY KEY. */
export function createObjectType(def: ObjectTypeDef): number {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO object_types (name, below_json, overlay_json, above_json, width, height, actions_json, anchor_x, anchor_y)
     VALUES (@name, @belowJson, @overlayJson, @aboveJson, @width, @height, @actionsJson, @anchorX, @anchorY)`,
    )
    .run({
      name: def.name,
      belowJson: def.below ? JSON.stringify(def.below) : null,
      overlayJson: def.overlay ? JSON.stringify(def.overlay) : null,
      aboveJson: def.above ? JSON.stringify(def.above) : null,
      width: def.width,
      height: def.height,
      actionsJson: def.actions ? JSON.stringify(def.actions) : null,
      anchorX: def.anchorX ?? null,
      anchorY: def.anchorY ?? null,
    });
  return Number(lastInsertRowid);
}

export function updateObjectType(id: number, def: ObjectTypeDef): void {
  db.prepare(
    `UPDATE object_types SET name = @name, below_json = @belowJson, overlay_json = @overlayJson,
     above_json = @aboveJson, width = @width, height = @height, actions_json = @actionsJson,
     anchor_x = @anchorX, anchor_y = @anchorY WHERE id = @id`,
  ).run({
    id,
    name: def.name,
    belowJson: def.below ? JSON.stringify(def.below) : null,
    overlayJson: def.overlay ? JSON.stringify(def.overlay) : null,
    aboveJson: def.above ? JSON.stringify(def.above) : null,
    width: def.width,
    height: def.height,
    actionsJson: def.actions ? JSON.stringify(def.actions) : null,
    anchorX: def.anchorX ?? null,
    anchorY: def.anchorY ?? null,
  });
}

export function deleteObjectType(id: number): void {
  db.prepare("DELETE FROM object_types WHERE id = ?").run(id);
}
