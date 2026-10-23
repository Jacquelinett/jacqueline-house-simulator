import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.join(import.meta.dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "houseSimulator.db"));
db.pragma("journal_mode = WAL");

/**
 * Schema setup, run once at startup. `CREATE TABLE IF NOT EXISTS` is a
 * no-op once a table already exists — it does NOT retroactively add a
 * column to an existing table (same gotcha val.town's own `ensureSchema()`
 * has, see CLAUDE.md's "Schema migration gotcha"). Every table below is
 * written in its current, final shape — there is no historical trail of
 * one-time migrations to run through anymore (this app has exactly one
 * real install; past migrations for the old string-id scheme, the
 * navigate->goTo rename, the overlay_json->sprite_overlays move, etc. all
 * already ran against it and were deleted once confirmed applied — see
 * this file's git history if you need the old shape for reference).
 *
 * The pattern for a FUTURE schema change is still the same as it's always
 * been: update the CREATE TABLE statement below (so a fresh install gets
 * the new shape directly), and add an `ALTER TABLE ... ADD COLUMN` (or
 * `DROP COLUMN`) to the maintenance block below it so the one real
 * existing install picks the change up too — just don't let either
 * accumulate: once an ALTER has actually run against the live db (and any
 * needed backfill has completed), fold its result into the CREATE TABLE
 * text and delete the ALTER line and any now-finished backfill function,
 * the same cleanup this file just went through. A meaningful backfill
 * (not just "what should this default to") belongs in the relevant
 * seed*IfEmpty() function instead when possible — see `src/scene/rooms.ts`'s
 * STATIC_ROOM_SPECS `visible: true` entries for the pattern: a fresh
 * install's seed data should already be correct, not rely on a separate
 * one-time fixup step afterward.
 */
export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      secret TEXT UNIQUE NOT NULL,
      aw_bucket_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      publish_to_viewer INTEGER NOT NULL DEFAULT 0,
      sprite_name TEXT,
      wger_api_token TEXT,
      activity_grace_period_seconds INTEGER NOT NULL DEFAULT 30
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
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
      character_id TEXT NOT NULL,
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
      character_id TEXT NOT NULL,
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
      admin_secret TEXT,
      -- One shared wger instance for the whole house; each character's own
      -- account on it is characters.wger_api_token instead (see that
      -- column's own comment) — this used to also hold one global
      -- wger_api_token/wger_character_id before per-character accounts
      -- were supported.
      wger_base_url TEXT
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
      show_right_wall INTEGER NOT NULL DEFAULT 1,
      show_bottom_left_wall INTEGER NOT NULL DEFAULT 0,
      show_bottom_right_wall INTEGER NOT NULL DEFAULT 0,
      wall_height INTEGER NOT NULL DEFAULT 8,
      visible INTEGER NOT NULL DEFAULT 0
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

    -- Mirrors RoomSpec.connectedTo (ConnectedToEntry[]). idx preserves
    -- array order since only entries[0] determines a room's own position
    -- (see resolveRooms()'s own comment) — idx 0 is always that primary
    -- entry, any further idx are additional asserted-but-unvalidated
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

  // activity_grace_period_seconds added after characters already existed on
  // the one real live install — CREATE TABLE IF NOT EXISTS is a no-op for an
  // existing table (see this file's own header comment), so the live row(s)
  // need an explicit ADD COLUMN too. SQLite backfills a non-NULL DEFAULT onto
  // every existing row when adding a NOT NULL column, so Jacqueline/Kevin's
  // existing characters get the real default (30s) here, not NULL.
  // better-sqlite3 is synchronous, so (unlike val.town's own .catch(() => {})
  // version of this same pattern) the no-op-once-applied guard is a try/catch.
  try {
    db.exec("ALTER TABLE characters ADD COLUMN activity_grace_period_seconds INTEGER NOT NULL DEFAULT 30");
  } catch {
    // already applied
  }

  // Same gotcha, same fix — wall_height added after rooms already existed
  // on the live install (the wall autotile rework, see tileset.ts's
  // WallPart). Every existing room gets the real default (8) here, not
  // NULL, so already-placed rooms keep rendering at the same wall height
  // they always have until an admin tunes it per-room.
  try {
    db.exec("ALTER TABLE rooms ADD COLUMN wall_height INTEGER NOT NULL DEFAULT 8");
  } catch {
    // already applied
  }

  seedJacquelineCharacter();
}

/** Keeps Jacqueline's existing lan_secret working unchanged as her character secret, so none of her already-configured devices need to re-enter anything. Published to the viewer by default — same "Jacqueline is the one public character" behavior the app has always had. Not a migration — this runs on every startup and is a no-op once her character row exists, same as any other seed*IfEmpty() function. */
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
