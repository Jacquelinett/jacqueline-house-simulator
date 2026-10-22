import { db } from "./db";

export interface Character {
  id: string;
  name: string;
  secret: string;
  awBucketId: string;
  publishToViewer: boolean;
}

interface CharacterRow {
  id: string;
  name: string;
  secret: string;
  aw_bucket_id: string;
  publish_to_viewer: number;
}

function fromRow(row: CharacterRow): Character {
  return { id: row.id, name: row.name, secret: row.secret, awBucketId: row.aw_bucket_id, publishToViewer: !!row.publish_to_viewer };
}

export function getCharacterBySecret(secret: string): Character | undefined {
  const row = db.prepare("SELECT id, name, secret, aw_bucket_id, publish_to_viewer FROM characters WHERE secret = ?").get(secret) as
    | CharacterRow
    | undefined;
  return row ? fromRow(row) : undefined;
}

export function getCharacterById(id: string): Character | undefined {
  const row = db.prepare("SELECT id, name, secret, aw_bucket_id, publish_to_viewer FROM characters WHERE id = ?").get(id) as
    | CharacterRow
    | undefined;
  return row ? fromRow(row) : undefined;
}

export function listCharacters(): Character[] {
  const rows = db.prepare("SELECT id, name, secret, aw_bucket_id, publish_to_viewer FROM characters ORDER BY created_at").all() as CharacterRow[];
  return rows.map(fromRow);
}

/** name "Kevin" -> bucket id "aw-stopwatch-kevin"; a duplicate slug gets a short random suffix rather than colliding. */
function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || crypto.randomUUID().slice(0, 8);
}

/** publish_to_viewer omitted — defaults to 0 (the column's own default), so a brand-new character is never published to val.town/the viewer until an admin opts them in. */
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
  return { id, name, secret, awBucketId: bucketId, publishToViewer: false };
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

export function deleteCharacter(id: string): void {
  db.prepare("DELETE FROM characters WHERE id = ?").run(id);
}
