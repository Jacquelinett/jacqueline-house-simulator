import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.join(import.meta.dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "houseSimulator.db"));
db.pragma("journal_mode = WAL");

function tableExists(table: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}

function columnType(table: string, column: string): string | undefined {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];
  return info.find((c) => c.name === column)?.type;
}

/**
 * One-time migration: rooms/objects/activities/object_types move from
 * hand-authored string/UUID primary keys to plain serial INTEGER ones (the
 * admin tool should never require typing an id, and renaming a room
 * shouldn't change its id — see CLAUDE.md's room/object/activity serial-id
 * migration). Detected by the `rooms.id` column's declared type — "TEXT"
 * means an install that predates this migration and has real data to
 * carry forward; already "INTEGER" (already migrated) or `rooms` not
 * existing at all (a brand-new install) both mean there's nothing to do
 * here — the normal CREATE TABLE IF NOT EXISTS block below handles a
 * fresh install directly in the final shape.
 *
 * Rebuilds every affected table under a temporary name with the final
 * schema, remapping every foreign-key reference — room_connections,
 * floors.base_room_id, objects.room_id/type_id, and the activityId/roomId
 * embedded in actions_json/action_json blobs — through old->new id maps
 * built from each table's own current rowid order (arbitrary but stable;
 * nothing about the old string ids carried meaning worth preserving).
 * Runs inside one transaction so a failure partway through never leaves
 * the database half-migrated. `rooms.level` is dropped in the rebuild
 * rather than carried over — it's derived from floor-connection membership
 * now, not stored (see RoomDef.level's own comment in scene/rooms.ts).
 */
function migrateIdsToSerial(): void {
  if (!tableExists("rooms")) return;
  if (columnType("rooms", "id") !== "TEXT") return;

  console.log("[db] migrating rooms/objects/activities/object_types to serial integer ids...");

  interface ActionLike {
    kind: string;
    activityId?: string | number;
    roomId?: string | number;
  }

  const tx = db.transaction(() => {
    const activityIdMap = new Map<string, number>();
    for (const row of db.prepare("SELECT id FROM activities ORDER BY rowid").all() as { id: string }[]) {
      activityIdMap.set(row.id, activityIdMap.size + 1);
    }
    const typeIdMap = new Map<string, number>();
    for (const row of db.prepare("SELECT id FROM object_types ORDER BY rowid").all() as { id: string }[]) {
      typeIdMap.set(row.id, typeIdMap.size + 1);
    }
    const roomIdMap = new Map<string, number>();
    for (const row of db.prepare("SELECT id FROM rooms ORDER BY rowid").all() as { id: string }[]) {
      roomIdMap.set(row.id, roomIdMap.size + 1);
    }
    const objectIdMap = new Map<string, number>(); // old `${room_id} ${id}` -> new global id
    if (tableExists("objects")) {
      for (const row of db.prepare("SELECT room_id, id FROM objects ORDER BY rowid").all() as { room_id: string; id: string }[]) {
        objectIdMap.set(`${row.room_id} ${row.id}`, objectIdMap.size + 1);
      }
    }

    function remapActionsJson(actionsJson: string | null): string | null {
      if (!actionsJson) return actionsJson;
      const actions = JSON.parse(actionsJson) as ActionLike[];
      for (const a of actions) {
        if (a.kind === "activity" && typeof a.activityId === "string") {
          const mapped = activityIdMap.get(a.activityId);
          if (mapped !== undefined) a.activityId = mapped;
        }
        if (a.kind === "navigate" && typeof a.roomId === "string") {
          const mapped = roomIdMap.get(a.roomId);
          if (mapped !== undefined) a.roomId = mapped;
        }
      }
      return JSON.stringify(actions);
    }

    // --- activities ---
    db.exec("ALTER TABLE activities RENAME TO activities_old");
    db.exec("CREATE TABLE activities (id INTEGER PRIMARY KEY, label TEXT UNIQUE NOT NULL, color INTEGER NOT NULL)");
    const insertActivity = db.prepare("INSERT INTO activities (id, label, color) VALUES (?, ?, ?)");
    for (const row of db.prepare("SELECT * FROM activities_old ORDER BY rowid").all() as { id: string; label: string; color: number }[]) {
      insertActivity.run(activityIdMap.get(row.id)!, row.label, row.color);
    }
    db.exec("DROP TABLE activities_old");

    // --- object_types ---
    db.exec("ALTER TABLE object_types RENAME TO object_types_old");
    db.exec(`
      CREATE TABLE object_types (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, below_json TEXT, overlay_json TEXT, above_json TEXT,
        width INTEGER NOT NULL, height INTEGER NOT NULL, actions_json TEXT, anchor_x REAL, anchor_y REAL
      )
    `);
    const insertType = db.prepare(`
      INSERT INTO object_types (id, name, below_json, overlay_json, above_json, width, height, actions_json, anchor_x, anchor_y)
      VALUES (@id, @name, @belowJson, @overlayJson, @aboveJson, @width, @height, @actionsJson, @anchorX, @anchorY)
    `);
    interface OldTypeRow {
      id: string;
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
    for (const row of db.prepare("SELECT * FROM object_types_old ORDER BY rowid").all() as OldTypeRow[]) {
      insertType.run({
        id: typeIdMap.get(row.id)!,
        name: row.name,
        belowJson: row.below_json,
        overlayJson: row.overlay_json,
        aboveJson: row.above_json,
        width: row.width,
        height: row.height,
        actionsJson: remapActionsJson(row.actions_json),
        anchorX: row.anchor_x,
        anchorY: row.anchor_y,
      });
    }
    db.exec("DROP TABLE object_types_old");

    // --- rooms (dropping `level`) ---
    db.exec("ALTER TABLE rooms RENAME TO rooms_old");
    db.exec(`
      CREATE TABLE rooms (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, cols INTEGER NOT NULL, rows INTEGER NOT NULL,
        floor_variant TEXT NOT NULL, wall_variant TEXT NOT NULL, floor_overrides_json TEXT, wall_overrides_json TEXT
      )
    `);
    const insertRoom = db.prepare(`
      INSERT INTO rooms (id, name, cols, rows, floor_variant, wall_variant, floor_overrides_json, wall_overrides_json)
      VALUES (@id, @name, @cols, @rows, @floorVariant, @wallVariant, @floorOverridesJson, @wallOverridesJson)
    `);
    interface OldRoomRow {
      id: string;
      name: string;
      cols: number;
      rows: number;
      floor_variant: string;
      wall_variant: string;
      floor_overrides_json: string | null;
      wall_overrides_json: string | null;
    }
    for (const row of db.prepare("SELECT * FROM rooms_old ORDER BY rowid").all() as OldRoomRow[]) {
      insertRoom.run({
        id: roomIdMap.get(row.id)!,
        name: row.name,
        cols: row.cols,
        rows: row.rows,
        floorVariant: row.floor_variant,
        wallVariant: row.wall_variant,
        floorOverridesJson: row.floor_overrides_json,
        wallOverridesJson: row.wall_overrides_json,
      });
    }
    db.exec("DROP TABLE rooms_old");

    // --- room_connections ---
    if (tableExists("room_connections")) {
      db.exec("ALTER TABLE room_connections RENAME TO room_connections_old");
      db.exec(`
        CREATE TABLE room_connections (
          room_id INTEGER NOT NULL, idx INTEGER NOT NULL, target_room_id INTEGER NOT NULL,
          direction TEXT NOT NULL, gap_tiles INTEGER NOT NULL DEFAULT 0, lateral_offset INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (room_id, idx)
        )
      `);
      const insertConnection = db.prepare(`
        INSERT INTO room_connections (room_id, idx, target_room_id, direction, gap_tiles, lateral_offset)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      interface OldConnectionRow {
        room_id: string;
        idx: number;
        target_room_id: string;
        direction: string;
        gap_tiles: number;
        lateral_offset: number;
      }
      for (const row of db.prepare("SELECT * FROM room_connections_old ORDER BY rowid").all() as OldConnectionRow[]) {
        const newRoomId = roomIdMap.get(row.room_id);
        const newTargetId = roomIdMap.get(row.target_room_id);
        if (newRoomId === undefined || newTargetId === undefined) continue; // dangling reference to an already-removed room
        insertConnection.run(newRoomId, row.idx, newTargetId, row.direction, row.gap_tiles, row.lateral_offset);
      }
      db.exec("DROP TABLE room_connections_old");
    }

    // --- objects (global id instead of (room_id, id) composite) ---
    if (tableExists("objects")) {
      db.exec("ALTER TABLE objects RENAME TO objects_old");
      db.exec(`
        CREATE TABLE objects (
          id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL, type_id INTEGER NOT NULL,
          x INTEGER NOT NULL, y INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, action_json TEXT
        )
      `);
      const insertObject = db.prepare(`
        INSERT INTO objects (id, room_id, type_id, x, y, enabled, action_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      interface OldObjectRow {
        id: string;
        room_id: string;
        type_id: string;
        x: number;
        y: number;
        enabled: number;
        action_json: string | null;
      }
      for (const row of db.prepare("SELECT * FROM objects_old ORDER BY rowid").all() as OldObjectRow[]) {
        const newRoomId = roomIdMap.get(row.room_id);
        const newTypeId = typeIdMap.get(row.type_id);
        if (newRoomId === undefined || newTypeId === undefined) continue; // dangling reference to an already-removed room/type
        insertObject.run(
          objectIdMap.get(`${row.room_id} ${row.id}`)!,
          newRoomId,
          newTypeId,
          row.x,
          row.y,
          row.enabled,
          remapActionsJson(row.action_json),
        );
      }
      db.exec("DROP TABLE objects_old");
    }

    // --- floors.base_room_id ---
    if (tableExists("floors")) {
      db.exec("ALTER TABLE floors RENAME TO floors_old");
      db.exec("CREATE TABLE floors (level INTEGER PRIMARY KEY, label TEXT NOT NULL, base_room_id INTEGER NOT NULL)");
      const insertFloor = db.prepare("INSERT INTO floors (level, label, base_room_id) VALUES (?, ?, ?)");
      interface OldFloorRow {
        level: number;
        label: string;
        base_room_id: string;
      }
      for (const row of db.prepare("SELECT * FROM floors_old ORDER BY rowid").all() as OldFloorRow[]) {
        const newBaseRoomId = roomIdMap.get(row.base_room_id);
        if (newBaseRoomId === undefined) continue; // dangling reference to an already-removed room
        insertFloor.run(row.level, row.label, newBaseRoomId);
      }
      db.exec("DROP TABLE floors_old");
    }
  });
  tx();

  console.log("[db] migration to serial ids complete");
}

/**
 * One-time content migration: `ObjectAction`'s "navigate" kind was renamed
 * to "goTo" (src/scene/rooms.ts), leaving any already-persisted
 * actions_json/action_json blob with the old literal string embedded in
 * it. A plain text substitution is safe here (not a JSON.parse/stringify
 * round-trip like migrateIdsToSerial's remapActionsJson) because
 * JSON.stringify never puts a space after a colon, so `"kind":"navigate"`
 * only ever appears as that exact substring — confirmed against this
 * app's own live data before relying on it. Naturally idempotent (nothing
 * matches once renamed), so unlike migrateIdsToSerial this runs
 * unconditionally every startup rather than needing its own gate —
 * except the object_types.actions_json half, which DOES need a gate now:
 * migrateTypeDefaultActionsToPlacements() below drops that column
 * entirely, and this function runs BEFORE it every startup, so a bare
 * `tableExists` check isn't enough once that column is actually gone —
 * confirmed live (SqliteError: no such column: actions_json on the
 * second startup after that migration shipped).
 */
function migrateNavigateActionKind(): void {
  if (tableExists("object_types") && columnType("object_types", "actions_json") !== undefined) {
    db.prepare(`UPDATE object_types SET actions_json = replace(actions_json, '"kind":"navigate"', '"kind":"goTo"') WHERE actions_json LIKE '%"kind":"navigate"%'`).run();
  }
  if (tableExists("objects")) {
    db.prepare(`UPDATE objects SET action_json = replace(action_json, '"kind":"navigate"', '"kind":"goTo"') WHERE action_json LIKE '%"kind":"navigate"%'`).run();
  }
}

/**
 * One-time migration: object types no longer have default actions at
 * all (src/scene/rooms.ts's ObjectTypeDef) — what an object does is
 * purely a per-placement concern now, no type-level fallback. Any
 * existing placement that was relying on its type's default
 * (action_json IS NULL, meaning "inherit") gets that default copied
 * onto it directly, so no existing object silently loses its action
 * the moment the type-level column goes away — then the column itself
 * is dropped (same "don't leave a dead column around as a future
 * landmine" stance as rooms.connected_to_* below). Gated on the column
 * still existing, so this is a near-instant no-op on every subsequent
 * startup once it's gone.
 */
function migrateTypeDefaultActionsToPlacements(): void {
  if (!tableExists("object_types") || columnType("object_types", "actions_json") === undefined) return;

  const types = db.prepare("SELECT id, actions_json FROM object_types WHERE actions_json IS NOT NULL").all() as {
    id: number;
    actions_json: string;
  }[];
  const actionsByType = new Map(types.map((t) => [t.id, t.actions_json]));

  if (tableExists("objects") && actionsByType.size > 0) {
    const placements = db.prepare("SELECT id, type_id FROM objects WHERE action_json IS NULL").all() as { id: number; type_id: number }[];
    const update = db.prepare("UPDATE objects SET action_json = ? WHERE id = ?");
    for (const placement of placements) {
      const defaultActions = actionsByType.get(placement.type_id);
      if (defaultActions) update.run(defaultActions, placement.id);
    }
  }

  db.exec("ALTER TABLE object_types DROP COLUMN actions_json");
}

/**
 * One-time migration: object_types.overlay (a single SpriteLayer embedded
 * inline as JSON) moves to its own sprite_overlays table, referenced by
 * overlay_id — so distinct object types can reference the same named
 * overlay instead of each hand-duplicating an identical inline blob, and
 * the admin tool can show/pick overlays by their spriteKey instead of
 * editing raw layer JSON per type (see admin-main.ts's Sprite Overlays
 * tab). Position (offsetX/offsetY) goes straight onto THIS type's own
 * overlay_offset_x/y columns, not into sprite_overlays — two types
 * referencing the same overlay can still want it positioned differently,
 * same reasoning below/above's own offsets are per-type too. Must run
 * AFTER the CREATE TABLE/ALTER block below — it needs sprite_overlays and
 * object_types.overlay_id/overlay_offset_x/overlay_offset_y to already
 * exist — unlike migrateNavigateActionKind/migrateTypeDefaultActionsToPlacements
 * above, which only ever touch columns that already exist going in. Gated
 * on overlay_json still existing, same idiom as those two: drops that
 * column once done, so this is a near-instant no-op on every later startup.
 */
function migrateOverlayJsonToSpriteOverlays(): void {
  if (!tableExists("object_types") || columnType("object_types", "overlay_json") === undefined) return;

  const rows = db.prepare("SELECT id, overlay_json FROM object_types WHERE overlay_json IS NOT NULL").all() as {
    id: number;
    overlay_json: string;
  }[];

  const insert = db.prepare(`INSERT INTO sprite_overlays (sprite_key, frame_count, frame_duration_ms) VALUES (@spriteKey, @frameCount, @frameDurationMs)`);
  const setOverlay = db.prepare("UPDATE object_types SET overlay_id = ?, overlay_offset_x = ?, overlay_offset_y = ? WHERE id = ?");

  for (const row of rows) {
    const layers = JSON.parse(row.overlay_json) as {
      texture?: string;
      offsetX?: number;
      offsetY?: number;
      spriteKey?: string;
      frameWidth?: number;
      frameHeight?: number;
      frameCount?: number;
      frameDurationMs?: number;
    }[];
    const layer = layers[0];
    if (!layer) continue;
    // Every real overlay authored so far has a spriteKey (it's what makes
    // per-character resolution possible at all) — this fallback only
    // exists so a hypothetical keyless overlay doesn't violate
    // sprite_key's NOT NULL/UNIQUE constraint, not because real data needs it.
    const spriteKey = layer.spriteKey?.trim() || `type${row.id}`;
    const { lastInsertRowid } = insert.run({
      spriteKey,
      frameCount: layer.frameCount ?? null,
      frameDurationMs: layer.frameDurationMs ?? null,
    });
    setOverlay.run(Number(lastInsertRowid), layer.offsetX ?? null, layer.offsetY ?? null, row.id);
  }

  db.exec("ALTER TABLE object_types DROP COLUMN overlay_json");
}

/**
 * One-time migration: overlay offsetX/offsetY move from sprite_overlays
 * (a shared, reusable entity) to object_types itself (overlay_offset_x/y)
 * — two object types referencing the SAME overlay need to be able to
 * position it differently, the same way below/above's own offsetX/offsetY
 * already live per-type rather than on a shared definition. Must run
 * AFTER the CREATE TABLE/ALTER block below (needs
 * object_types.overlay_offset_x/y to already exist) but BEFORE
 * sprite_overlays.offset_x/y are ever dropped. Gated on those columns
 * still existing on sprite_overlays — drops them itself once done, same
 * idiom as every other migration in this file. A no-op for any install
 * that went straight from the previous (texture/frameWidth/frameHeight)
 * shape to this one via migrateOverlayJsonToSpriteOverlays above, since
 * that function never writes offset_x/y into sprite_overlays anymore —
 * this exists specifically for an install that passed through the
 * brief window where sprite_overlays.offset_x/y existed and held real data.
 */
function migrateOverlayOffsetToObjectType(): void {
  if (!tableExists("sprite_overlays") || columnType("sprite_overlays", "offset_x") === undefined) return;

  const types = db.prepare("SELECT id, overlay_id FROM object_types WHERE overlay_id IS NOT NULL").all() as { id: number; overlay_id: number }[];
  const getOffsets = db.prepare("SELECT offset_x, offset_y FROM sprite_overlays WHERE id = ?");
  const update = db.prepare("UPDATE object_types SET overlay_offset_x = ?, overlay_offset_y = ? WHERE id = ?");
  for (const type of types) {
    const overlay = getOffsets.get(type.overlay_id) as { offset_x: number | null; offset_y: number | null } | undefined;
    if (overlay) update.run(overlay.offset_x, overlay.offset_y, type.id);
  }

  db.exec("ALTER TABLE sprite_overlays DROP COLUMN offset_x");
  db.exec("ALTER TABLE sprite_overlays DROP COLUMN offset_y");
}

/**
 * Schema migration, run once at startup — `CREATE TABLE IF NOT EXISTS` is a
 * no-op once a table already exists, same gotcha val.town's own
 * `ensureSchema()` has (see CLAUDE.md's "Schema migration gotcha"): it
 * won't retroactively add a column to an existing table. Any future
 * column addition needs an explicit `ALTER TABLE ... ADD COLUMN`
 * (`.catch`-safe — these throw if the column already exists) alongside
 * updating the `CREATE TABLE` statement here for fresh installs.
 */
export function migrate(): void {
  migrateIdsToSerial();
  migrateNavigateActionKind();
  migrateTypeDefaultActionsToPlacements();

  // Captured BEFORE the CREATE TABLE/ALTER TABLE below — `characters` not
  // existing at all also counts as "predates this column" (a fresh
  // install's seedJacquelineCharacter() already sets 1 explicitly, so the
  // backfill below is a harmless no-op for it either way). This is what
  // makes the backfill run exactly once, on whichever startup actually
  // introduces the column — not on every subsequent one, which would
  // otherwise silently undo an admin unchecking it later (same landmine
  // already hit once with rooms.connected_to_* — see that comment below).
  const hadPublishToViewerColumnAlready = tableExists("characters") && columnType("characters", "publish_to_viewer") !== undefined;

  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      secret TEXT UNIQUE NOT NULL,
      aw_bucket_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      publish_to_viewer INTEGER NOT NULL DEFAULT 0,
      sprite_name TEXT
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      character_id TEXT,
      activity_label TEXT NOT NULL,
      target_minutes INTEGER NOT NULL,
      recurrence_json TEXT NOT NULL,
      skip_dates_json TEXT,
      created_at TEXT,
      streak_start_date TEXT,
      highest_streak INTEGER
    );

    CREATE TABLE IF NOT EXISTS goal_history (
      goal_id TEXT NOT NULL,
      character_id TEXT,
      date TEXT NOT NULL,
      activity_label TEXT NOT NULL,
      target_minutes INTEGER NOT NULL,
      actual_minutes REAL NOT NULL,
      outcome TEXT NOT NULL,
      PRIMARY KEY (goal_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_history_date ON goal_history(date);

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      character_id TEXT,
      text TEXT NOT NULL,
      done INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_settings (
      device_id TEXT PRIMARY KEY,
      scale REAL NOT NULL,
      theme TEXT NOT NULL,
      dev_mode INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS server_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      broadcast_url TEXT,
      broadcast_secret TEXT,
      lan_secret TEXT,
      admin_secret TEXT
    );

    CREATE TABLE IF NOT EXISTS workout_sessions (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      date TEXT NOT NULL,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workout_sessions_date ON workout_sessions(character_id, date);

    CREATE TABLE IF NOT EXISTS workout_sets (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      exercise_name TEXT NOT NULL,
      weight REAL,
      reps INTEGER NOT NULL,
      set_order INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY,
      label TEXT UNIQUE NOT NULL,
      color INTEGER NOT NULL
    );

    -- One row per named overlay (spriteKey + optional frame-animation
    -- fields) — object_types.overlay_id references this by id, so
    -- multiple types can share one overlay definition instead of each
    -- embedding an identical inline blob (see server/spriteOverlays.ts,
    -- admin-main.ts's Sprite Overlays tab). No texture column — a sprite-
    -- keyed overlay's art is always "<characterSpriteName>_<spriteKey>.png",
    -- falling back to the same convention for DEFAULT_SPRITE_CHARACTER
    -- ("jacqueline") rather than a separately-authored fallback file (see
    -- characterSprites.ts). No frame_width/frame_height either — a
    -- spritesheet's frames are always its own full height and equal-width
    -- slices of its own width, derived at load time from the resolved
    -- texture's natural size (renderer.ts's sliceFrames) rather than typed
    -- in separately. No offset_x/offset_y either — position is a per-
    -- OBJECT-TYPE concern (object_types.overlay_offset_x/y below), not
    -- part of this shared entity, since two types reusing the same
    -- overlay can still want it positioned differently.
    CREATE TABLE IF NOT EXISTS sprite_overlays (
      id INTEGER PRIMARY KEY,
      sprite_key TEXT NOT NULL UNIQUE,
      frame_count INTEGER,
      frame_duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS object_types (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      below_json TEXT,
      above_json TEXT,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      anchor_x REAL,
      anchor_y REAL,
      overlay_id INTEGER,
      overlay_offset_x REAL,
      overlay_offset_y REAL
    );

    -- Mirrors src/scene/rooms.ts's RoomSpec shape (not flattened absolute
    -- x/y) specifically so the client's existing resolveRooms() — which
    -- resolves connectedTo chains into pixel positions — can be reused
    -- as-is against server-provided rows instead of reimplementing that
    -- chain-resolution logic a second time. No level column -- level is
    -- derived from floor-connection membership (see RoomDef.level's own
    -- comment in scene/rooms.ts), not stored.
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      cols INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      floor_variant TEXT NOT NULL,
      wall_variant TEXT NOT NULL,
      floor_overrides_json TEXT,
      wall_overrides_json TEXT,
      show_left_wall INTEGER NOT NULL DEFAULT 1,
      show_right_wall INTEGER NOT NULL DEFAULT 1
    );

    -- Mirrors ObjectPlacement: type_id + position + optional per-placement
    -- action override (null action_json means "use the type's defaults").
    -- id is a plain global serial id (not scoped to one room the way it
    -- used to be — see ObjectPlacement's own comment on why), so a plain
    -- INTEGER PRIMARY KEY is enough on its own, no composite key needed.
    CREATE TABLE IF NOT EXISTS objects (
      id INTEGER PRIMARY KEY,
      room_id INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      action_json TEXT
    );

    -- Mirrors RoomSpec.connectedTo (ConnectedToEntry[]) — superseded the
    -- rooms table's old single-connection connected_to_* columns, which
    -- have since been dropped (see migrate()'s own comment on why). idx
    -- preserves array order since only entries[0] determines a room's own
    -- position (see resolveRooms()'s own comment) — idx 0 is always that
    -- primary entry, any further idx are additional asserted-but-unvalidated
    -- doorway facts. room_id is NOT the primary key alone since a room can
    -- have more than one entry.
    CREATE TABLE IF NOT EXISTS room_connections (
      room_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      target_room_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      gap_tiles INTEGER NOT NULL DEFAULT 0,
      lateral_offset INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, idx)
    );

    -- A floor is a level plus its designated base room — see
    -- src/scene/floors.ts's own comment. level is the primary key (one
    -- floor per level), not an arbitrary id, since "which floor is this"
    -- is inherently the level number.
    CREATE TABLE IF NOT EXISTS floors (
      level INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      base_room_id INTEGER NOT NULL
    );
  `);

  // ALTER TABLE for columns added to tables that may already exist on a
  // pre-multi-character install — CREATE TABLE IF NOT EXISTS above is a
  // no-op for those, see this function's own long-standing comment.
  for (const stmt of [
    "ALTER TABLE goals ADD COLUMN character_id TEXT",
    "ALTER TABLE goal_history ADD COLUMN character_id TEXT",
    "ALTER TABLE todos ADD COLUMN character_id TEXT",
    "ALTER TABLE server_config ADD COLUMN admin_secret TEXT",
    "ALTER TABLE object_types ADD COLUMN anchor_x REAL",
    "ALTER TABLE object_types ADD COLUMN anchor_y REAL",
    "ALTER TABLE object_types ADD COLUMN overlay_id INTEGER",
    "ALTER TABLE object_types ADD COLUMN overlay_offset_x REAL",
    "ALTER TABLE object_types ADD COLUMN overlay_offset_y REAL",
    "ALTER TABLE rooms ADD COLUMN show_left_wall INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE rooms ADD COLUMN show_right_wall INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE characters ADD COLUMN publish_to_viewer INTEGER NOT NULL DEFAULT 0",
    // Nullable, no backfill needed (unlike publish_to_viewer's meaningful
    // default) — null just means "no custom sprite, use the shared
    // default texture for any sprite-keyed overlay" (see
    // src/scene/characterSprites.ts).
    "ALTER TABLE characters ADD COLUMN sprite_name TEXT",
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // column already exists
    }
  }

  // DROP COLUMN for columns retired entirely — the inverse of the ADD
  // COLUMN loop above, same try/catch-and-ignore idempotency (throws if
  // the column's already gone). rooms.connected_to_* (superseded by the
  // room_connections table) is the one case of this so far: the old
  // single-connection columns were kept around "just in case" rather than
  // dropped when room_connections was introduced, on general principle —
  // but that turned out to be an active landmine, not a harmless leftover:
  // a one-time backfill function kept reading them on every startup,
  // gated only on "the row it inserts already exists," so the moment an
  // admin deleted a connection (clearing the room_connections row but not
  // this stale column, which nothing ever wrote null to), the next server
  // restart silently resurrected the deleted connection straight from
  // here. No code reads these anymore and the one-time migration that
  // ever needed them has already run against every room that had real
  // data in them, so they're dropped outright rather than left inert.
  // sprite_overlays.texture/frame_width/frame_height — retired the same
  // day they were introduced, once it turned out a sprite-keyed overlay's
  // texture is always derivable ("<characterSpriteName>_<spriteKey>.png",
  // falling back to DEFAULT_SPRITE_CHARACTER's own file) and a
  // spritesheet's frame dimensions are always derivable from its own
  // natural size / frameCount — nothing left that ever needs these typed
  // in. migrateOverlayJsonToSpriteOverlays() above never writes them
  // either, so this is just cleanup for an install that ran this app in
  // the brief window those columns existed.
  for (const stmt of [
    "ALTER TABLE rooms DROP COLUMN connected_to_room_id",
    "ALTER TABLE rooms DROP COLUMN connected_to_direction",
    "ALTER TABLE rooms DROP COLUMN connected_to_gap_tiles",
    "ALTER TABLE sprite_overlays DROP COLUMN texture",
    "ALTER TABLE sprite_overlays DROP COLUMN frame_width",
    "ALTER TABLE sprite_overlays DROP COLUMN frame_height",
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // column already dropped
    }
  }

  migrateOverlayJsonToSpriteOverlays();
  migrateOverlayOffsetToObjectType();

  seedJacquelineCharacter();
  backfillCharacterId();
  if (!hadPublishToViewerColumnAlready) backfillJacquelinePublishToViewer();
}

/** Keeps Jacqueline's existing lan_secret working unchanged as her character secret, so none of her already-configured devices need to re-enter anything. Published to the viewer by default — same "Jacqueline is the one public character" behavior as before publish_to_viewer existed at all. */
function seedJacquelineCharacter(): void {
  const existing = db.prepare("SELECT id FROM characters WHERE name = 'Jacqueline'").get();
  if (existing) return;

  const config = db.prepare("SELECT lan_secret FROM server_config WHERE id = 1").get() as
    | { lan_secret: string | null }
    | undefined;
  const secret = config?.lan_secret || crypto.randomUUID();
  db.prepare(
    "INSERT INTO characters (id, name, secret, aw_bucket_id, created_at, publish_to_viewer) VALUES (?, 'Jacqueline', ?, 'aw-stopwatch', ?, 1)",
  ).run(crypto.randomUUID(), secret, new Date().toISOString());
}

/**
 * One-time backfill for an install that predates publish_to_viewer —
 * every push/broadcast used to hardcode "only Jacqueline" (see
 * server/rpc.ts, server/index.ts's own comments), so this preserves that
 * exact behavior unconditionally rather than leaving her suddenly
 * unpublished the moment this column appeared. Only called once ever
 * (guarded by migrate()'s own hadPublishToViewerColumnAlready check) —
 * an admin who explicitly unchecks it later never has this run again to
 * silently re-enable it.
 */
function backfillJacquelinePublishToViewer(): void {
  db.prepare("UPDATE characters SET publish_to_viewer = 1 WHERE name = 'Jacqueline'").run();
}

/** One-time backfill for rows that predate the character_id column. */
function backfillCharacterId(): void {
  const jacqueline = db.prepare("SELECT id FROM characters WHERE name = 'Jacqueline'").get() as { id: string };
  db.prepare("UPDATE goals SET character_id = ? WHERE character_id IS NULL").run(jacqueline.id);
  db.prepare("UPDATE goal_history SET character_id = ? WHERE character_id IS NULL").run(jacqueline.id);
  db.prepare("UPDATE todos SET character_id = ? WHERE character_id IS NULL").run(jacqueline.id);
}
