import { db } from "./db";
import { ConnectedToEntry, ConnectionDirection, ObjectAction, ObjectPlacement, RoomSpecWire, STATIC_ROOM_SPECS } from "../src/scene/rooms";
import { TileOverride } from "../src/scene/tileset";

interface RoomRow {
  id: number;
  name: string;
  cols: number;
  rows: number;
  floor_variant: string;
  wall_variant: string;
  floor_overrides_json: string | null;
  wall_overrides_json: string | null;
  show_left_wall: number;
  show_right_wall: number;
  show_bottom_left_wall: number;
  show_bottom_right_wall: number;
  visible: number;
}

interface ConnectionRow {
  room_id: number;
  idx: number;
  target_room_id: number;
  direction: ConnectionDirection;
  gap_tiles: number;
  lateral_offset: number;
}

interface ObjectRow {
  id: number;
  room_id: number;
  type_id: number;
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

  const objectsByRoom = new Map<number, ObjectPlacement[]>();
  for (const row of objectRows) {
    const list = objectsByRoom.get(row.room_id) ?? [];
    list.push(rowToPlacement(row));
    objectsByRoom.set(row.room_id, list);
  }

  const connectionsByRoom = new Map<number, ConnectedToEntry[]>();
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
    floorVariant: row.floor_variant,
    wallVariant: row.wall_variant,
    floorOverrides: row.floor_overrides_json ? (JSON.parse(row.floor_overrides_json) as TileOverride[]) : undefined,
    wallOverrides: row.wall_overrides_json ? (JSON.parse(row.wall_overrides_json) as TileOverride[]) : undefined,
    showLeftWall: !!row.show_left_wall,
    showRightWall: !!row.show_right_wall,
    showBottomLeftWall: !!row.show_bottom_left_wall,
    showBottomRightWall: !!row.show_bottom_right_wall,
    visible: !!row.visible,
    connectedTo: connectionsByRoom.get(row.id),
    objects: objectsByRoom.get(row.id) ?? [],
  }));
}

function replaceConnections(roomId: number, entries: ConnectedToEntry[] | undefined): void {
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
 * two-variant registry). Explicit ids throughout, matching STATIC_ROOM_SPECS'
 * own literal ids (rooms.ts), same as seedObjectTypesIfEmpty()/
 * seedActivitiesIfEmpty() — no `level` column (dropped; derived at resolve
 * time instead, see RoomDef.level's own comment in scene/rooms.ts).
 */
export function seedRoomsIfEmpty(): void {
  const { n } = db.prepare("SELECT COUNT(*) as n FROM rooms").get() as { n: number };
  if (n > 0) return;

  const insertRoom = db.prepare(`
    INSERT INTO rooms (id, name, cols, rows, floor_variant, wall_variant, floor_overrides_json, wall_overrides_json, show_left_wall, show_right_wall, show_bottom_left_wall, show_bottom_right_wall, visible)
    VALUES (@id, @name, @cols, @rows, '/floors/floor1.png', '/walls/wall1.png', @floorOverridesJson, @wallOverridesJson, @showLeftWall, @showRightWall, @showBottomLeftWall, @showBottomRightWall, @visible)
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
        floorOverridesJson: spec.floorOverrides ? JSON.stringify(spec.floorOverrides) : null,
        wallOverridesJson: spec.wallOverrides ? JSON.stringify(spec.wallOverrides) : null,
        showLeftWall: spec.showLeftWall === false ? 0 : 1,
        showRightWall: spec.showRightWall === false ? 0 : 1,
        showBottomLeftWall: spec.showBottomLeftWall === true ? 1 : 0,
        showBottomRightWall: spec.showBottomRightWall === true ? 1 : 0,
        // Not set per-spec here (STATIC_ROOM_SPECS predates this field
        // entirely) — migrate()'s own backfillDefaultVisibleRooms turns
        // the right few on right after this seed runs, same as it does
        // for an upgrading install.
        visible: spec.visible === true ? 1 : 0,
      });
      replaceConnections(spec.id, spec.connectedTo);
      for (const placement of spec.objects) {
        insertObject.run({
          id: placement.id, // always set explicitly in STATIC_ROOM_SPECS
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

/** No id — rooms.id is server-assigned (INTEGER PRIMARY KEY, omitted from the INSERT so SQLite auto-assigns the next one). */
export function createRoom(spec: Omit<RoomSpecInput, "id">): number {
  const tx = db.transaction((): number => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO rooms (name, cols, rows, floor_variant, wall_variant, floor_overrides_json, wall_overrides_json, show_left_wall, show_right_wall, show_bottom_left_wall, show_bottom_right_wall, visible)
       VALUES (@name, @cols, @rows, @floorVariant, @wallVariant, @floorOverridesJson, @wallOverridesJson, @showLeftWall, @showRightWall, @showBottomLeftWall, @showBottomRightWall, @visible)`,
      )
      .run({
        name: spec.name,
        cols: spec.cols,
        rows: spec.rows,
        floorVariant: spec.floorVariant,
        wallVariant: spec.wallVariant,
        floorOverridesJson: spec.floorOverrides ? JSON.stringify(spec.floorOverrides) : null,
        wallOverridesJson: spec.wallOverrides ? JSON.stringify(spec.wallOverrides) : null,
        showLeftWall: spec.showLeftWall === false ? 0 : 1,
        showRightWall: spec.showRightWall === false ? 0 : 1,
        showBottomLeftWall: spec.showBottomLeftWall === true ? 1 : 0,
        showBottomRightWall: spec.showBottomRightWall === true ? 1 : 0,
        visible: spec.visible === true ? 1 : 0,
      });
    const id = Number(lastInsertRowid);
    replaceConnections(id, spec.connectedTo);
    return id;
  });
  return tx();
}

export function updateRoom(spec: RoomSpecInput): void {
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE rooms SET name = @name, cols = @cols, rows = @rows, floor_variant = @floorVariant, wall_variant = @wallVariant,
       floor_overrides_json = @floorOverridesJson, wall_overrides_json = @wallOverridesJson,
       show_left_wall = @showLeftWall, show_right_wall = @showRightWall,
       show_bottom_left_wall = @showBottomLeftWall, show_bottom_right_wall = @showBottomRightWall, visible = @visible WHERE id = @id`,
    ).run({
      id: spec.id,
      name: spec.name,
      cols: spec.cols,
      rows: spec.rows,
      floorVariant: spec.floorVariant,
      wallVariant: spec.wallVariant,
      floorOverridesJson: spec.floorOverrides ? JSON.stringify(spec.floorOverrides) : null,
      wallOverridesJson: spec.wallOverrides ? JSON.stringify(spec.wallOverrides) : null,
      showLeftWall: spec.showLeftWall === false ? 0 : 1,
      showRightWall: spec.showRightWall === false ? 0 : 1,
      showBottomLeftWall: spec.showBottomLeftWall === true ? 1 : 0,
      showBottomRightWall: spec.showBottomRightWall === true ? 1 : 0,
      visible: spec.visible === true ? 1 : 0,
    });
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
export function updateRoomConnections(roomId: number, connectedTo: ConnectedToEntry[] | undefined): void {
  const tx = db.transaction(() => {
    replaceConnections(roomId, connectedTo);
  });
  tx();
}

export function deleteRoom(id: number): void {
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

/** No id — objects.id is server-assigned (global INTEGER PRIMARY KEY, omitted from the INSERT so SQLite auto-assigns the next one). */
export function createObject(roomId: number, placement: Omit<ObjectPlacement, "id">): number {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO objects (room_id, type_id, x, y, enabled, action_json)
     VALUES (@roomId, @typeId, @x, @y, @enabled, @actionJson)`,
    )
    .run({
      roomId,
      typeId: placement.type,
      x: placement.x,
      y: placement.y,
      enabled: placement.enabled === false ? 0 : 1,
      actionJson: placement.actions ? JSON.stringify(placement.actions) : null,
    });
  return Number(lastInsertRowid);
}

export function updateObject(roomId: number, placement: ObjectPlacement & { id: number }): void {
  db.prepare(
    `UPDATE objects SET type_id = @typeId, x = @x, y = @y, enabled = @enabled, action_json = @actionJson
     WHERE id = @id AND room_id = @roomId`,
  ).run({
    id: placement.id,
    roomId,
    typeId: placement.type,
    x: placement.x,
    y: placement.y,
    enabled: placement.enabled === false ? 0 : 1,
    actionJson: placement.actions ? JSON.stringify(placement.actions) : null,
  });
}

export function deleteObject(roomId: number, objectId: number): void {
  db.prepare("DELETE FROM objects WHERE room_id = ? AND id = ?").run(roomId, objectId);
}
