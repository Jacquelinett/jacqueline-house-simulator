import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.join(import.meta.dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "houseSimulator.db"));
db.pragma("journal_mode = WAL");

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      secret TEXT UNIQUE NOT NULL,
      aw_bucket_id TEXT NOT NULL,
      created_at TEXT NOT NULL
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
      id TEXT PRIMARY KEY,
      label TEXT UNIQUE NOT NULL,
      color INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS object_types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      below_json TEXT,
      overlay_json TEXT,
      above_json TEXT,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      actions_json TEXT,
      anchor_x REAL,
      anchor_y REAL
    );

    -- Mirrors src/scene/rooms.ts's RoomSpec shape (not flattened absolute
    -- x/y) specifically so the client's existing resolveRooms() — which
    -- resolves connectedTo chains into pixel positions — can be reused
    -- as-is against server-provided rows instead of reimplementing that
    -- chain-resolution logic a second time.
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cols INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      level INTEGER NOT NULL DEFAULT 0,
      floor_variant TEXT NOT NULL,
      wall_variant TEXT NOT NULL,
      floor_overrides_json TEXT,
      wall_overrides_json TEXT,
      connected_to_room_id TEXT,
      connected_to_direction TEXT,
      connected_to_gap_tiles INTEGER
    );

    -- Mirrors ObjectPlacement: type_id + position + optional per-placement
    -- action override (null action_json means "use the type's defaults").
    -- id is only unique WITHIN a room (e.g. two different rooms can each
    -- have a "stairs-up"), not globally — same as ObjectPlacement.id's own
    -- original "disambiguates instances in one room" contract — so the
    -- primary key is the (room_id, id) pair, not id alone.
    CREATE TABLE IF NOT EXISTS objects (
      id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      type_id TEXT NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      action_json TEXT,
      PRIMARY KEY (room_id, id)
    );

    -- Mirrors RoomSpec.connectedTo now being ConnectedToEntry[] instead of
    -- one optional object — the old rooms.connected_to_* columns (still
    -- present above, left unused rather than dropped, same never-drop-a-
    -- column convention as everywhere else) could only ever hold one. idx
    -- preserves array order since only entries[0] determines a room's own
    -- position (see resolveRooms()'s own comment) — idx 0 is always that
    -- primary entry, any further idx are additional asserted-but-unvalidated
    -- doorway facts. room_id is NOT the primary key alone since a room can
    -- have more than one entry.
    CREATE TABLE IF NOT EXISTS room_connections (
      room_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      target_room_id TEXT NOT NULL,
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
      base_room_id TEXT NOT NULL
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
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // column already exists
    }
  }

  seedJacquelineCharacter();
  backfillCharacterId();
  backfillRoomConnections();
}

/**
 * One-time carry-over from the old single-connection rooms.connected_to_*
 * columns into room_connections (idx 0, i.e. the primary/position-
 * determining entry) — idempotent via INSERT OR IGNORE against the
 * (room_id, idx) primary key, so it's a no-op on every run after the
 * first. Only runs for rooms that actually had a connection; an anchor
 * room (connected_to_room_id IS NULL) correctly gets no row at all.
 */
function backfillRoomConnections(): void {
  db.exec(`
    INSERT OR IGNORE INTO room_connections (room_id, idx, target_room_id, direction, gap_tiles, lateral_offset)
    SELECT id, 0, connected_to_room_id, connected_to_direction, connected_to_gap_tiles, 0
    FROM rooms
    WHERE connected_to_room_id IS NOT NULL
  `);
}

/** Keeps Jacqueline's existing lan_secret working unchanged as her character secret, so none of her already-configured devices need to re-enter anything. */
function seedJacquelineCharacter(): void {
  const existing = db.prepare("SELECT id FROM characters WHERE name = 'Jacqueline'").get();
  if (existing) return;

  const config = db.prepare("SELECT lan_secret FROM server_config WHERE id = 1").get() as
    | { lan_secret: string | null }
    | undefined;
  const secret = config?.lan_secret || crypto.randomUUID();
  db.prepare(
    "INSERT INTO characters (id, name, secret, aw_bucket_id, created_at) VALUES (?, 'Jacqueline', ?, 'aw-stopwatch', ?)",
  ).run(crypto.randomUUID(), secret, new Date().toISOString());
}

/** One-time backfill for rows that predate the character_id column. */
function backfillCharacterId(): void {
  const jacqueline = db.prepare("SELECT id FROM characters WHERE name = 'Jacqueline'").get() as { id: string };
  db.prepare("UPDATE goals SET character_id = ? WHERE character_id IS NULL").run(jacqueline.id);
  db.prepare("UPDATE goal_history SET character_id = ? WHERE character_id IS NULL").run(jacqueline.id);
  db.prepare("UPDATE todos SET character_id = ? WHERE character_id IS NULL").run(jacqueline.id);
}
