import { db } from "./db";
import { ConnectedToEntry, ConnectionDirection, ObjectAction, ObjectPlacement, RoomSpecWire, STATIC_ROOM_SPECS } from "../src/scene/rooms";
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
}

interface ConnectionRow {
  room_id: string;
  idx: number;
  target_room_id: string;
  direction: ConnectionDirection;
  gap_tiles: number;
  lateral_offset: number;
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

/** Full room list, each with its own objects and connections joined in — the one thing the client's resolveRooms()/roomSpecsFromWire() need. */
export function getRoomSpecs(): RoomSpecWire[] {
  const roomRows = db.prepare("SELECT * FROM rooms").all() as RoomRow[];
  const objectRows = db.prepare("SELECT * FROM objects").all() as ObjectRow[];
  const connectionRows = db.prepare("SELECT * FROM room_connections ORDER BY room_id, idx").all() as ConnectionRow[];

  const objectsByRoom = new Map<string, ObjectPlacement[]>();
  for (const row of objectRows) {
    const list = objectsByRoom.get(row.room_id) ?? [];
    list.push(rowToPlacement(row));
    objectsByRoom.set(row.room_id, list);
  }

  const connectionsByRoom = new Map<string, ConnectedToEntry[]>();
  for (const row of connectionRows) {
    const list = connectionsByRoom.get(row.room_id) ?? [];
    list.push({ roomId: row.target_room_id, direction: row.direction, gapTiles: row.gap_tiles, lateralOffset: row.lateral_offset });
    connectionsByRoom.set(row.room_id, list);
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
    connectedTo: connectionsByRoom.get(row.id),
    objects: objectsByRoom.get(row.id) ?? [],
  }));
}

function replaceConnections(roomId: string, entries: ConnectedToEntry[] | undefined): void {
  db.prepare("DELETE FROM room_connections WHERE room_id = ?").run(roomId);
  const insert = db.prepare(`
    INSERT INTO room_connections (room_id, idx, target_room_id, direction, gap_tiles, lateral_offset)
    VALUES (@roomId, @idx, @targetRoomId, @direction, @gapTiles, @lateralOffset)
  `);
  (entries ?? []).forEach((entry, idx) => {
    insert.run({ roomId, idx, targetRoomId: entry.roomId, direction: entry.direction, gapTiles: entry.gapTiles, lateralOffset: entry.lateralOffset ?? 0 });
  });
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
    INSERT INTO rooms (id, name, cols, rows, level, floor_variant, wall_variant, floor_overrides_json, wall_overrides_json)
    VALUES (@id, @name, @cols, @rows, @level, 'floor1', 'wall1', @floorOverridesJson, @wallOverridesJson)
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
      });
      replaceConnections(spec.id, spec.connectedTo);
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

export type RoomSpecInput = Omit<RoomSpecWire, "objects">;

const roomUpsert = db.prepare(`
  INSERT INTO rooms (id, name, cols, rows, level, floor_variant, wall_variant, floor_overrides_json, wall_overrides_json)
  VALUES (@id, @name, @cols, @rows, @level, @floorVariant, @wallVariant, @floorOverridesJson, @wallOverridesJson)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, cols=excluded.cols, rows=excluded.rows, level=excluded.level,
    floor_variant=excluded.floor_variant, wall_variant=excluded.wall_variant,
    floor_overrides_json=excluded.floor_overrides_json, wall_overrides_json=excluded.wall_overrides_json
`);

function roomUpsertParams(spec: RoomSpecInput) {
  return {
    id: spec.id,
    name: spec.name,
    cols: spec.cols,
    rows: spec.rows,
    level: spec.level,
    floorVariant: spec.floorVariant,
    wallVariant: spec.wallVariant,
    floorOverridesJson: spec.floorOverrides ? JSON.stringify(spec.floorOverrides) : null,
    wallOverridesJson: spec.wallOverrides ? JSON.stringify(spec.wallOverrides) : null,
  };
}

export function createRoom(spec: RoomSpecInput): void {
  const tx = db.transaction(() => {
    roomUpsert.run(roomUpsertParams(spec));
    replaceConnections(spec.id, spec.connectedTo);
  });
  tx();
}

export function updateRoom(spec: RoomSpecInput): void {
  const tx = db.transaction(() => {
    roomUpsert.run(roomUpsertParams(spec));
    replaceConnections(spec.id, spec.connectedTo);
  });
  tx();
}

/**
 * Connections-only write — touches room_connections exclusively, never
 * the rooms table's other columns. updateRoom() above always overwrites
 * every column (it's a full upsert, not a partial update), so a caller
 * that only means to change connectedTo but spreads a possibly-stale
 * in-memory room snapshot into the request risks silently reverting
 * whatever else changed server-side since that snapshot was taken (name,
 * size, variant, wall overrides, ...) — this endpoint makes that bug
 * impossible by construction rather than relying on every caller
 * remembering to keep its snapshot fresh.
 */
export function updateRoomConnections(roomId: string, connectedTo: ConnectedToEntry[] | undefined): void {
  const tx = db.transaction(() => {
    replaceConnections(roomId, connectedTo);
  });
  tx();
}

export function deleteRoom(id: string): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM objects WHERE room_id = ?").run(id);
    db.prepare("DELETE FROM room_connections WHERE room_id = ?").run(id);
    // A different room's own connectedTo entries may still reference this
    // one as their target — left dangling rather than cascaded, same
    // "hand-coordinated, not automatically validated" stance as the rest of
    // this system; getRoomSpecs()/resolveRooms() will surface a clear
    // "unknown room" error the next time that room is resolved, rather than
    // silently vanishing a connection the admin didn't ask to remove.
    db.prepare("DELETE FROM rooms WHERE id = ?").run(id);
  });
  tx();
}

const objectUpsert = db.prepare(`
  INSERT INTO objects (id, room_id, type_id, x, y, enabled, action_json)
  VALUES (@id, @roomId, @typeId, @x, @y, @enabled, @actionJson)
  ON CONFLICT(room_id, id) DO UPDATE SET type_id=excluded.type_id, x=excluded.x, y=excluded.y,
    enabled=excluded.enabled, action_json=excluded.action_json
`);

function objectUpsertParams(roomId: string, placement: ObjectPlacement) {
  return {
    id: placement.id ?? placement.type,
    roomId,
    typeId: placement.type,
    x: placement.x,
    y: placement.y,
    enabled: placement.enabled === false ? 0 : 1,
    actionJson: placement.actions ? JSON.stringify(placement.actions) : null,
  };
}

export function createObject(roomId: string, placement: ObjectPlacement): void {
  objectUpsert.run(objectUpsertParams(roomId, placement));
}

export function updateObject(roomId: string, placement: ObjectPlacement): void {
  objectUpsert.run(objectUpsertParams(roomId, placement));
}

export function deleteObject(roomId: string, objectId: string): void {
  db.prepare("DELETE FROM objects WHERE room_id = ? AND id = ?").run(roomId, objectId);
}
