import { db } from "./db";
import { ObjectAction, ObjectPlacement, RoomSpecWire, STATIC_ROOM_SPECS, ConnectionDirection } from "../src/scene/rooms";
import { TileOverride } from "../src/scene/tileset";

interface RoomRow {
  id: string;
  name: string;
  cols: number;
  rows: number;
  level: number;
  floor_variant: string;
  wall_variant: string;
  floor_overrides_json: string | null;
  wall_overrides_json: string | null;
  connected_to_room_id: string | null;
  connected_to_direction: ConnectionDirection | null;
  connected_to_gap_tiles: number | null;
}

interface ObjectRow {
  id: string;
  room_id: string;
  type_id: string;
  x: number;
  y: number;
  enabled: number;
  action_json: string | null;
}

function rowToPlacement(row: ObjectRow): ObjectPlacement {
  return {
    type: row.type_id,
    id: row.id,
    enabled: !!row.enabled,
    x: row.x,
    y: row.y,
    actions: row.action_json ? (JSON.parse(row.action_json) as ObjectAction[]) : undefined,
  };
}

/** Full room list, each with its own objects joined in — the one thing the client's resolveRooms()/roomSpecsFromWire() need. */
export function getRoomSpecs(): RoomSpecWire[] {
  const roomRows = db.prepare("SELECT * FROM rooms").all() as RoomRow[];
  const objectRows = db.prepare("SELECT * FROM objects").all() as ObjectRow[];

  const objectsByRoom = new Map<string, ObjectPlacement[]>();
  for (const row of objectRows) {
    const list = objectsByRoom.get(row.room_id) ?? [];
    list.push(rowToPlacement(row));
    objectsByRoom.set(row.room_id, list);
  }

  return roomRows.map((row) => ({
    id: row.id,
    name: row.name,
    cols: row.cols,
    rows: row.rows,
    level: row.level,
    floorVariant: row.floor_variant,
    wallVariant: row.wall_variant,
    floorOverrides: row.floor_overrides_json ? (JSON.parse(row.floor_overrides_json) as TileOverride[]) : undefined,
    wallOverrides: row.wall_overrides_json ? (JSON.parse(row.wall_overrides_json) as TileOverride[]) : undefined,
    connectedTo: row.connected_to_room_id
      ? { roomId: row.connected_to_room_id, direction: row.connected_to_direction!, gapTiles: row.connected_to_gap_tiles! }
      : undefined,
    objects: objectsByRoom.get(row.id) ?? [],
  }));
}

/**
 * One-time seed from scene/rooms.ts's STATIC_ROOM_SPECS — every existing
 * room spec uses the same floor1/wall1 variant pair, so the variant
 * objects are seeded by their known registry names directly rather than
 * needing a reverse object->name lookup (not worth building for a
 * two-variant registry).
 */
export function seedRoomsIfEmpty(): void {
  const { n } = db.prepare("SELECT COUNT(*) as n FROM rooms").get() as { n: number };
  if (n > 0) return;

  const insertRoom = db.prepare(`
    INSERT INTO rooms (id, name, cols, rows, level, floor_variant, wall_variant, floor_overrides_json, wall_overrides_json,
      connected_to_room_id, connected_to_direction, connected_to_gap_tiles)
    VALUES (@id, @name, @cols, @rows, @level, 'floor1', 'wall1', @floorOverridesJson, @wallOverridesJson,
      @connectedToRoomId, @connectedToDirection, @connectedToGapTiles)
  `);
  const insertObject = db.prepare(`
    INSERT INTO objects (id, room_id, type_id, x, y, enabled, action_json)
    VALUES (@id, @roomId, @typeId, @x, @y, @enabled, @actionJson)
  `);

  const tx = db.transaction(() => {
    for (const spec of STATIC_ROOM_SPECS) {
      insertRoom.run({
        id: spec.id,
        name: spec.name,
        cols: spec.cols,
        rows: spec.rows,
        level: spec.level ?? 0,
        floorOverridesJson: spec.floorOverrides ? JSON.stringify(spec.floorOverrides) : null,
        wallOverridesJson: spec.wallOverrides ? JSON.stringify(spec.wallOverrides) : null,
        connectedToRoomId: spec.connectedTo?.roomId ?? null,
        connectedToDirection: spec.connectedTo?.direction ?? null,
        connectedToGapTiles: spec.connectedTo?.gapTiles ?? null,
      });
      for (const placement of spec.objects) {
        insertObject.run({
          id: placement.id ?? placement.type,
          roomId: spec.id,
          typeId: placement.type,
          x: placement.x,
          y: placement.y,
          enabled: placement.enabled === false ? 0 : 1,
          actionJson: placement.actions ? JSON.stringify(placement.actions) : null,
        });
      }
    }
  });
  tx();
}
