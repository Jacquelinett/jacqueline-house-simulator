import { db } from "./db";
import { ObjectTypeDef, SpriteLayer, STATIC_OBJECT_TYPES } from "../src/scene/rooms";
import { createSprite } from "./sprites";

interface TypeRow {
  id: number;
  name: string;
  below_json: string | null;
  above_json: string | null;
  width: number;
  height: number;
  anchor_x: number | null;
  anchor_y: number | null;
  sprite_id: number | null;
  sprite_offset_x: number | null;
  sprite_offset_y: number | null;
  tags_json: string | null;
  linked_sprite_key: string | null;
  linked_frame_count: number | null;
  linked_frame_duration_ms: number | null;
}

// Joins sprites so the interaction sprite comes back fully resolved,
// matching the shape every consumer (renderer.ts/admin-main.ts/viewer)
// already expects — see ObjectTypeDef.sprite's own comment in rooms.ts on
// why sprite itself is read-only/derived while spriteId/spriteOffsetX/Y
// are the real fields. Position (sprite_offset_x/y) is THIS type's own
// column, not joined from sprites — two types referencing the same sprite
// can still position it differently.
const SELECT_TYPES_SQL = `
  SELECT ot.id, ot.name, ot.below_json, ot.above_json, ot.width, ot.height, ot.anchor_x, ot.anchor_y,
         ot.sprite_id, ot.sprite_offset_x, ot.sprite_offset_y, ot.tags_json,
         s.sprite_key AS linked_sprite_key,
         s.frame_count AS linked_frame_count, s.frame_duration_ms AS linked_frame_duration_ms
  FROM object_types ot
  LEFT JOIN sprites s ON s.id = ot.sprite_id
`;

function rowToType(row: TypeRow): ObjectTypeDef {
  const sprite: SpriteLayer | undefined = row.sprite_id
    ? {
        offsetX: row.sprite_offset_x ?? undefined,
        offsetY: row.sprite_offset_y ?? undefined,
        spriteKey: row.linked_sprite_key ?? undefined,
        frameCount: row.linked_frame_count ?? undefined,
        frameDurationMs: row.linked_frame_duration_ms ?? undefined,
      }
    : undefined;
  return {
    id: row.id,
    name: row.name,
    width: row.width,
    height: row.height,
    below: row.below_json ? (JSON.parse(row.below_json) as SpriteLayer[]) : undefined,
    sprite: sprite ? [sprite] : undefined,
    spriteId: row.sprite_id ?? undefined,
    spriteOffsetX: row.sprite_offset_x ?? undefined,
    spriteOffsetY: row.sprite_offset_y ?? undefined,
    above: row.above_json ? (JSON.parse(row.above_json) as SpriteLayer[]) : undefined,
    anchorX: row.anchor_x ?? undefined,
    anchorY: row.anchor_y ?? undefined,
    tags: row.tags_json ? (JSON.parse(row.tags_json) as string[]) : undefined,
  };
}

/** Keyed by id (object_types.id), matching the shape client-side setObjectTypes() expects. */
export function getObjectTypes(): Record<string, ObjectTypeDef> {
  const rows = db.prepare(SELECT_TYPES_SQL).all() as TypeRow[];
  const result: Record<string, ObjectTypeDef> = {};
  for (const row of rows) result[row.id] = rowToType(row);
  return result;
}

/** One-time seed from scene/rooms.ts's STATIC_OBJECT_TYPES — explicit ids matching that registry's own literal ids, so existing STATIC_ROOM_SPECS placements (type: STATIC_OBJECT_TYPES.piano.id) resolve against the seeded rows unchanged. A seed type's own sprite (only Piano's, today) gets its own sprites row created first (spriteKey/frame fields only — position is this type's own column below), same as any admin-authored sprite — there's no bulk/shared seed path for sprites since only one type has ever needed one. */
export function seedObjectTypesIfEmpty(): void {
  const { n } = db.prepare("SELECT COUNT(*) as n FROM object_types").get() as { n: number };
  if (n > 0) return;
  const insert = db.prepare(`
    INSERT INTO object_types (id, name, below_json, above_json, width, height, anchor_x, anchor_y, sprite_id, sprite_offset_x, sprite_offset_y, tags_json)
    VALUES (@id, @name, @belowJson, @aboveJson, @width, @height, @anchorX, @anchorY, @spriteId, @spriteOffsetX, @spriteOffsetY, @tagsJson)
  `);
  const tx = db.transaction(() => {
    for (const type of Object.values(STATIC_OBJECT_TYPES) as ObjectTypeDef[]) {
      const spriteId = type.sprite?.[0] ? createSprite(type.sprite[0]) : null;
      insert.run({
        id: type.id,
        name: type.name,
        belowJson: type.below ? JSON.stringify(type.below) : null,
        aboveJson: type.above ? JSON.stringify(type.above) : null,
        width: type.width,
        height: type.height,
        anchorX: type.anchorX ?? null,
        anchorY: type.anchorY ?? null,
        spriteId,
        spriteOffsetX: type.sprite?.[0]?.offsetX ?? null,
        spriteOffsetY: type.sprite?.[0]?.offsetY ?? null,
        tagsJson: type.tags ? JSON.stringify(type.tags) : null,
      });
    }
  });
  tx();
}

/** `def.id` (if present) is ignored — id omitted from the INSERT so SQLite auto-assigns the next INTEGER PRIMARY KEY. `def.sprite` is ignored too (it's read-only/derived, see ObjectTypeDef's own comment) — only `def.spriteId`/`def.spriteOffsetX`/`def.spriteOffsetY` are persisted. */
export function createObjectType(def: ObjectTypeDef): number {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO object_types (name, below_json, above_json, width, height, anchor_x, anchor_y, sprite_id, sprite_offset_x, sprite_offset_y, tags_json)
     VALUES (@name, @belowJson, @aboveJson, @width, @height, @anchorX, @anchorY, @spriteId, @spriteOffsetX, @spriteOffsetY, @tagsJson)`,
    )
    .run({
      name: def.name,
      belowJson: def.below ? JSON.stringify(def.below) : null,
      aboveJson: def.above ? JSON.stringify(def.above) : null,
      width: def.width,
      height: def.height,
      anchorX: def.anchorX ?? null,
      anchorY: def.anchorY ?? null,
      spriteId: def.spriteId ?? null,
      spriteOffsetX: def.spriteOffsetX ?? null,
      spriteOffsetY: def.spriteOffsetY ?? null,
      tagsJson: def.tags ? JSON.stringify(def.tags) : null,
    });
  return Number(lastInsertRowid);
}

export function updateObjectType(id: number, def: ObjectTypeDef): void {
  db.prepare(
    `UPDATE object_types SET name = @name, below_json = @belowJson,
     above_json = @aboveJson, width = @width, height = @height,
     anchor_x = @anchorX, anchor_y = @anchorY, sprite_id = @spriteId,
     sprite_offset_x = @spriteOffsetX, sprite_offset_y = @spriteOffsetY, tags_json = @tagsJson WHERE id = @id`,
  ).run({
    id,
    name: def.name,
    belowJson: def.below ? JSON.stringify(def.below) : null,
    aboveJson: def.above ? JSON.stringify(def.above) : null,
    width: def.width,
    height: def.height,
    anchorX: def.anchorX ?? null,
    anchorY: def.anchorY ?? null,
    spriteId: def.spriteId ?? null,
    spriteOffsetX: def.spriteOffsetX ?? null,
    spriteOffsetY: def.spriteOffsetY ?? null,
    tagsJson: def.tags ? JSON.stringify(def.tags) : null,
  });
}

export function deleteObjectType(id: number): void {
  db.prepare("DELETE FROM object_types WHERE id = ?").run(id);
}
