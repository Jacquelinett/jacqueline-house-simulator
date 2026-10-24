import { db } from "./db";
import { SpriteLayer } from "../src/scene/rooms";

/**
 * A named, reusable sprite — the per-character-attributed layer object
 * types show while being interacted with (see SpriteLayer's own comment in
 * rooms.ts). Pulled out of object_types' inline overlay_json into its own
 * table (server/db.ts's migrateOverlayJsonToSpriteOverlays) so distinct
 * object types can reference the same sprite by id instead of each
 * duplicating an identical blob, and the admin tool can show/pick one by
 * its spriteKey rather than editing raw layer JSON per type. No texture
 * column — a sprite-keyed entry's art is always resolved from spriteKey
 * alone at render time (src/scene/characterSprites.ts); no frame_width/
 * frame_height either — derived from the resolved texture's own natural
 * size (src/scene/renderer.ts's sliceFrames) rather than authored. No
 * offsetX/offsetY either — position is a per-OBJECT-TYPE concern
 * (object_types.sprite_offset_x/y, server/objectTypes.ts), not part of
 * this shared entity, since two types reusing the same sprite can still
 * want it positioned differently (same reasoning below/above's own
 * offsets already live per-type rather than on shared art).
 */
export interface SpriteDef {
  id: number;
  spriteKey: string;
  layer: SpriteLayer;
}

interface SpriteRow {
  id: number;
  sprite_key: string;
  frame_count: number | null;
  frame_duration_ms: number | null;
}

function rowToSprite(row: SpriteRow): SpriteDef {
  return {
    id: row.id,
    spriteKey: row.sprite_key,
    layer: {
      spriteKey: row.sprite_key,
      frameCount: row.frame_count ?? undefined,
      frameDurationMs: row.frame_duration_ms ?? undefined,
    },
  };
}

export function getSprites(): SpriteDef[] {
  const rows = db.prepare("SELECT * FROM sprites ORDER BY sprite_key").all() as SpriteRow[];
  return rows.map(rowToSprite);
}

/** `layer.spriteKey` is the required identifying field — frame fields are optional, same shape the admin tool's sprite editor already produces. */
export function createSprite(layer: SpriteLayer): number {
  const spriteKey = layer.spriteKey?.trim();
  if (!spriteKey) throw new Error("spriteKey is required");
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO sprites (sprite_key, frame_count, frame_duration_ms) VALUES (@spriteKey, @frameCount, @frameDurationMs)`)
    .run({
      spriteKey,
      frameCount: layer.frameCount ?? null,
      frameDurationMs: layer.frameDurationMs ?? null,
    });
  return Number(lastInsertRowid);
}

export function updateSprite(id: number, layer: SpriteLayer): void {
  const spriteKey = layer.spriteKey?.trim();
  if (!spriteKey) throw new Error("spriteKey is required");
  db.prepare(`UPDATE sprites SET sprite_key = @spriteKey, frame_count = @frameCount, frame_duration_ms = @frameDurationMs WHERE id = @id`).run({
    id,
    spriteKey,
    frameCount: layer.frameCount ?? null,
    frameDurationMs: layer.frameDurationMs ?? null,
  });
}

/** Clears any object_types.sprite_id still pointing at this row first, so deleting a shared sprite never leaves a dangling reference — no "this is in use" guard beyond that, same no-automatic-validation stance as the rest of this system (e.g. resolveRooms()'s own comment on connectedTo cycles). */
export function deleteSprite(id: number): void {
  db.prepare("UPDATE object_types SET sprite_id = NULL WHERE sprite_id = ?").run(id);
  db.prepare("DELETE FROM sprites WHERE id = ?").run(id);
}
