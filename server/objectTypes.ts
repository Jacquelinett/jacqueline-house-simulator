import { db } from "./db";
import { ObjectTypeDef, SpriteLayer, STATIC_OBJECT_TYPES } from "../src/scene/rooms";
import { createSpriteOverlay } from "./spriteOverlays";

interface TypeRow {
  id: number;
  name: string;
  below_json: string | null;
  above_json: string | null;
  width: number;
  height: number;
  anchor_x: number | null;
  anchor_y: number | null;
  overlay_id: number | null;
  overlay_sprite_key: string | null;
  overlay_texture: string | null;
  overlay_offset_x: number | null;
  overlay_offset_y: number | null;
  overlay_frame_width: number | null;
  overlay_frame_height: number | null;
  overlay_frame_count: number | null;
  overlay_frame_duration_ms: number | null;
}

// Joins sprite_overlays so overlay comes back fully resolved, matching the
// shape every consumer (renderer.ts/admin-main.ts/viewer) already expects
// — see ObjectTypeDef.overlay's own comment in rooms.ts on why overlay
// itself is read-only/derived while overlayId is the real foreign key.
const SELECT_TYPES_SQL = `
  SELECT ot.id, ot.name, ot.below_json, ot.above_json, ot.width, ot.height, ot.anchor_x, ot.anchor_y,
         ot.overlay_id,
         so.sprite_key AS overlay_sprite_key, so.texture AS overlay_texture,
         so.offset_x AS overlay_offset_x, so.offset_y AS overlay_offset_y,
         so.frame_width AS overlay_frame_width, so.frame_height AS overlay_frame_height,
         so.frame_count AS overlay_frame_count, so.frame_duration_ms AS overlay_frame_duration_ms
  FROM object_types ot
  LEFT JOIN sprite_overlays so ON so.id = ot.overlay_id
`;

function rowToType(row: TypeRow): ObjectTypeDef {
  const overlay: SpriteLayer | undefined = row.overlay_id
    ? {
        texture: row.overlay_texture ?? undefined,
        offsetX: row.overlay_offset_x ?? undefined,
        offsetY: row.overlay_offset_y ?? undefined,
        spriteKey: row.overlay_sprite_key ?? undefined,
        frameWidth: row.overlay_frame_width ?? undefined,
        frameHeight: row.overlay_frame_height ?? undefined,
        frameCount: row.overlay_frame_count ?? undefined,
        frameDurationMs: row.overlay_frame_duration_ms ?? undefined,
      }
    : undefined;
  return {
    id: row.id,
    name: row.name,
    width: row.width,
    height: row.height,
    below: row.below_json ? (JSON.parse(row.below_json) as SpriteLayer[]) : undefined,
    overlay: overlay ? [overlay] : undefined,
    overlayId: row.overlay_id ?? undefined,
    above: row.above_json ? (JSON.parse(row.above_json) as SpriteLayer[]) : undefined,
    anchorX: row.anchor_x ?? undefined,
    anchorY: row.anchor_y ?? undefined,
  };
}

/** Keyed by id (object_types.id), matching the shape client-side setObjectTypes() expects. */
export function getObjectTypes(): Record<string, ObjectTypeDef> {
  const rows = db.prepare(SELECT_TYPES_SQL).all() as TypeRow[];
  const result: Record<string, ObjectTypeDef> = {};
  for (const row of rows) result[row.id] = rowToType(row);
  return result;
}

/** One-time seed from scene/rooms.ts's STATIC_OBJECT_TYPES — explicit ids matching that registry's own literal ids, so existing STATIC_ROOM_SPECS placements (type: STATIC_OBJECT_TYPES.piano.id) resolve against the seeded rows unchanged. A seed type's own overlay (only Piano's, today) gets its own sprite_overlays row created first, same as any admin-authored overlay — there's no bulk/shared seed path for overlays since only one type has ever needed one. */
export function seedObjectTypesIfEmpty(): void {
  const { n } = db.prepare("SELECT COUNT(*) as n FROM object_types").get() as { n: number };
  if (n > 0) return;
  const insert = db.prepare(`
    INSERT INTO object_types (id, name, below_json, above_json, width, height, anchor_x, anchor_y, overlay_id)
    VALUES (@id, @name, @belowJson, @aboveJson, @width, @height, @anchorX, @anchorY, @overlayId)
  `);
  const tx = db.transaction(() => {
    for (const type of Object.values(STATIC_OBJECT_TYPES) as ObjectTypeDef[]) {
      const overlayId = type.overlay?.[0] ? createSpriteOverlay(type.overlay[0]) : null;
      insert.run({
        id: type.id,
        name: type.name,
        belowJson: type.below ? JSON.stringify(type.below) : null,
        aboveJson: type.above ? JSON.stringify(type.above) : null,
        width: type.width,
        height: type.height,
        anchorX: type.anchorX ?? null,
        anchorY: type.anchorY ?? null,
        overlayId,
      });
    }
  });
  tx();
}

/** `def.id` (if present) is ignored — id omitted from the INSERT so SQLite auto-assigns the next INTEGER PRIMARY KEY. `def.overlay` is ignored too (it's read-only/derived, see ObjectTypeDef's own comment) — only `def.overlayId` is persisted. */
export function createObjectType(def: ObjectTypeDef): number {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO object_types (name, below_json, above_json, width, height, anchor_x, anchor_y, overlay_id)
     VALUES (@name, @belowJson, @aboveJson, @width, @height, @anchorX, @anchorY, @overlayId)`,
    )
    .run({
      name: def.name,
      belowJson: def.below ? JSON.stringify(def.below) : null,
      aboveJson: def.above ? JSON.stringify(def.above) : null,
      width: def.width,
      height: def.height,
      anchorX: def.anchorX ?? null,
      anchorY: def.anchorY ?? null,
      overlayId: def.overlayId ?? null,
    });
  return Number(lastInsertRowid);
}

export function updateObjectType(id: number, def: ObjectTypeDef): void {
  db.prepare(
    `UPDATE object_types SET name = @name, below_json = @belowJson,
     above_json = @aboveJson, width = @width, height = @height,
     anchor_x = @anchorX, anchor_y = @anchorY, overlay_id = @overlayId WHERE id = @id`,
  ).run({
    id,
    name: def.name,
    belowJson: def.below ? JSON.stringify(def.below) : null,
    aboveJson: def.above ? JSON.stringify(def.above) : null,
    width: def.width,
    height: def.height,
    anchorX: def.anchorX ?? null,
    anchorY: def.anchorY ?? null,
    overlayId: def.overlayId ?? null,
  });
}

export function deleteObjectType(id: number): void {
  db.prepare("DELETE FROM object_types WHERE id = ?").run(id);
}
