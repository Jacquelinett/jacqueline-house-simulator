import { db } from "./db";

export interface Character {
  id: string;
  name: string;
  secret: string;
  awBucketId: string;
  publishToViewer: boolean;
  spriteName: string | null;
  /** This character's own wger DRF API token, or null if they don't have a linked wger account — see server/wger.ts, which resolves this per-character now rather than through one global server_config singleton. */
  wgerApiToken: string | null;
}

interface CharacterRow {
  id: string;
  name: string;
  secret: string;
  aw_bucket_id: string;
  publish_to_viewer: number;
  sprite_name: string | null;
  wger_api_token: string | null;
}

const SELECT_COLUMNS = "id, name, secret, aw_bucket_id, publish_to_viewer, sprite_name, wger_api_token";

function fromRow(row: CharacterRow): Character {
  return {
    id: row.id,
    name: row.name,
    secret: row.secret,
    awBucketId: row.aw_bucket_id,
    publishToViewer: !!row.publish_to_viewer,
    spriteName: row.sprite_name,
    wgerApiToken: row.wger_api_token,
  };
}

export function getCharacterBySecret(secret: string): Character | undefined {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM characters WHERE secret = ?`).get(secret) as CharacterRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function getCharacterById(id: string): Character | undefined {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM characters WHERE id = ?`).get(id) as CharacterRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function listCharacters(): Character[] {
  const rows = db.prepare(`SELECT ${SELECT_COLUMNS} FROM characters ORDER BY created_at`).all() as CharacterRow[];
  return rows.map(fromRow);
}

/** name "Kevin" -> bucket id "aw-stopwatch-kevin"; a duplicate slug gets a short random suffix rather than colliding. */
function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || crypto.randomUUID().slice(0, 8);
}

/** publish_to_viewer/sprite_name omitted — default to 0/null (the columns' own defaults), so a brand-new character is never published to val.town/the viewer and has no custom sprite until an admin opts them in. */
export function createCharacter(name: string): Character {
  const id = crypto.randomUUID();
  const secret = crypto.randomUUID();
  let bucketId = `aw-stopwatch-${slugify(name)}`;
  if (db.prepare("SELECT 1 FROM characters WHERE aw_bucket_id = ?").get(bucketId)) {
    bucketId = `aw-stopwatch-${slugify(name)}-${id.slice(0, 8)}`;
  }
  db.prepare(
    "INSERT INTO characters (id, name, secret, aw_bucket_id, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, name, secret, bucketId, new Date().toISOString());
  return { id, name, secret, awBucketId: bucketId, publishToViewer: false, spriteName: null, wgerApiToken: null };
}

export function renameCharacter(id: string, name: string): void {
  db.prepare("UPDATE characters SET name = ? WHERE id = ?").run(name, id);
}

/** Changing a character's secret immediately invalidates every device currently connected with the old one — the WS auth lookup is always by secret, not a cached session, so the next reconnect attempt (or the self-healing reconnect logic) just gets a 4001 until re-entered with the new value. */
export function updateCharacterSecret(id: string, secret: string): void {
  db.prepare("UPDATE characters SET secret = ? WHERE id = ?").run(secret, id);
}

/** Changing a character's AW bucket id does NOT move their existing tracked history — it's a different aw-server bucket from here on, same as pointing a character at someone else's bucket would be. Only meaningful to change before real tracking has happened on the old one. */
export function updateCharacterBucket(id: string, awBucketId: string): void {
  db.prepare("UPDATE characters SET aw_bucket_id = ? WHERE id = ?").run(awBucketId, id);
}

/** Whether this character's status/goals/stats/period-stats/yesterday/streaks get pushed to val.town at all (server/index.ts's startup pushes, server/rpc.ts's post-activity-change push) — see CLAUDE.md's "Characters" section. Turning this off doesn't retroactively delete anything already pushed; val.town just stops hearing about this character going forward. */
export function updateCharacterPublishToViewer(id: string, publishToViewer: boolean): void {
  db.prepare("UPDATE characters SET publish_to_viewer = ? WHERE id = ?").run(publishToViewer ? 1 : 0, id);
}

/** The "key" every sprite-keyed object overlay resolves against (src/scene/characterSprites.ts: `${spriteName}_${key}.png`) — null means "no custom sprite," falling back to that overlay's own shared default texture. An empty string from the admin form is normalized to null rather than persisted as a literal empty-string sprite name. */
export function updateCharacterSpriteName(id: string, spriteName: string | null): void {
  db.prepare("UPDATE characters SET sprite_name = ? WHERE id = ?").run(spriteName || null, id);
}

/** This character's own wger DRF API token — see server/wger.ts's header comment on why this moved here from the old single-row server_config.wger_api_token/wger_character_id singleton: each character can now have their own wger account on the shared instance (server_config.wger_base_url), not just one account attributed to whichever one character it happened to belong to. An empty string from the admin form is normalized to null (no linked account), same convention updateCharacterSpriteName already uses. */
export function updateCharacterWgerApiToken(id: string, wgerApiToken: string | null): void {
  db.prepare("UPDATE characters SET wger_api_token = ? WHERE id = ?").run(wgerApiToken || null, id);
}

export function deleteCharacter(id: string): void {
  db.prepare("DELETE FROM characters WHERE id = ?").run(id);
}
