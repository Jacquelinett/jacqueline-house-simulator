import { db } from "./db";
import { SpriteLayer } from "../src/scene/rooms";

/**
 * A named, reusable overlay sprite — the per-character-attributed layer
 * object types show while in use (see SpriteLayer's own comment in
 * rooms.ts). Pulled out of object_types' inline overlay_json into its own
 * table (server/db.ts's migrateOverlayJsonToSpriteOverlays) so distinct
 * object types can reference the same overlay by id instead of each
 * duplicating an identical blob, and the admin tool can show/pick one by
 * its spriteKey rather than editing raw layer JSON per type.
 */
export interface SpriteOverlayDef {
  id: number;
  spriteKey: string;
  layer: SpriteLayer;
}

interface OverlayRow {
  id: number;
  sprite_key: string;
  texture: string | null;
  offset_x: number | null;
  offset_y: number | null;
  frame_width: number | null;
  frame_height: number | null;
  frame_count: number | null;
  frame_duration_ms: number | null;
}

function rowToOverlay(row: OverlayRow): SpriteOverlayDef {
  return {
    id: row.id,
    spriteKey: row.sprite_key,
    layer: {
      texture: row.texture ?? undefined,
      offsetX: row.offset_x ?? undefined,
      offsetY: row.offset_y ?? undefined,
      spriteKey: row.sprite_key,
      frameWidth: row.frame_width ?? undefined,
      frameHeight: row.frame_height ?? undefined,
      frameCount: row.frame_count ?? undefined,
      frameDurationMs: row.frame_duration_ms ?? undefined,
    },
  };
}

export function getSpriteOverlays(): SpriteOverlayDef[] {
  const rows = db.prepare("SELECT * FROM sprite_overlays ORDER BY sprite_key").all() as OverlayRow[];
  return rows.map(rowToOverlay);
}

/** `layer.spriteKey` is the required identifying field — the rest (texture/offset/frame fields) are all optional, same shape the admin tool's buildLayerSection already produces. */
export function createSpriteOverlay(layer: SpriteLayer): number {
  const spriteKey = layer.spriteKey?.trim();
  if (!spriteKey) throw new Error("spriteKey is required");
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO sprite_overlays (sprite_key, texture, offset_x, offset_y, frame_width, frame_height, frame_count, frame_duration_ms)
       VALUES (@spriteKey, @texture, @offsetX, @offsetY, @frameWidth, @frameHeight, @frameCount, @frameDurationMs)`,
    )
    .run({
      spriteKey,
      texture: layer.texture ?? null,
      offsetX: layer.offsetX ?? null,
      offsetY: layer.offsetY ?? null,
      frameWidth: layer.frameWidth ?? null,
      frameHeight: layer.frameHeight ?? null,
      frameCount: layer.frameCount ?? null,
      frameDurationMs: layer.frameDurationMs ?? null,
    });
  return Number(lastInsertRowid);
}

export function updateSpriteOverlay(id: number, layer: SpriteLayer): void {
  const spriteKey = layer.spriteKey?.trim();
  if (!spriteKey) throw new Error("spriteKey is required");
  db.prepare(
    `UPDATE sprite_overlays SET sprite_key = @spriteKey, texture = @texture, offset_x = @offsetX, offset_y = @offsetY,
     frame_width = @frameWidth, frame_height = @frameHeight, frame_count = @frameCount, frame_duration_ms = @frameDurationMs
     WHERE id = @id`,
  ).run({
    id,
    spriteKey,
    texture: layer.texture ?? null,
    offsetX: layer.offsetX ?? null,
    offsetY: layer.offsetY ?? null,
    frameWidth: layer.frameWidth ?? null,
    frameHeight: layer.frameHeight ?? null,
    frameCount: layer.frameCount ?? null,
    frameDurationMs: layer.frameDurationMs ?? null,
  });
}

/** Clears any object_types.overlay_id still pointing at this row first, so deleting a shared overlay never leaves a dangling reference — no "this is in use" guard beyond that, same no-automatic-validation stance as the rest of this system (e.g. resolveRooms()'s own comment on connectedTo cycles). */
export function deleteSpriteOverlay(id: number): void {
  db.prepare("UPDATE object_types SET overlay_id = NULL WHERE overlay_id = ?").run(id);
  db.prepare("DELETE FROM sprite_overlays WHERE id = ?").run(id);
}
