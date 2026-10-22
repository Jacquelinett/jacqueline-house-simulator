import { db } from "./db";

export interface Character {
  id: string;
  name: string;
  secret: string;
  awBucketId: string;
}

interface CharacterRow {
  id: string;
  name: string;
  secret: string;
  aw_bucket_id: string;
}

function fromRow(row: CharacterRow): Character {
  return { id: row.id, name: row.name, secret: row.secret, awBucketId: row.aw_bucket_id };
}

export function getCharacterBySecret(secret: string): Character | undefined {
  const row = db.prepare("SELECT id, name, secret, aw_bucket_id FROM characters WHERE secret = ?").get(secret) as
    | CharacterRow
    | undefined;
  return row ? fromRow(row) : undefined;
}

export function getCharacterById(id: string): Character | undefined {
  const row = db.prepare("SELECT id, name, secret, aw_bucket_id FROM characters WHERE id = ?").get(id) as
    | CharacterRow
    | undefined;
  return row ? fromRow(row) : undefined;
}

export function listCharacters(): Character[] {
  const rows = db.prepare("SELECT id, name, secret, aw_bucket_id FROM characters ORDER BY created_at").all() as CharacterRow[];
  return rows.map(fromRow);
}

/** name "Kevin" -> bucket id "aw-stopwatch-kevin"; a duplicate slug gets a short random suffix rather than colliding. */
function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || crypto.randomUUID().slice(0, 8);
}

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
  return { id, name, secret, awBucketId: bucketId };
}

export function renameCharacter(id: string, name: string): void {
  db.prepare("UPDATE characters SET name = ? WHERE id = ?").run(name, id);
}

export function deleteCharacter(id: string): void {
  db.prepare("DELETE FROM characters WHERE id = ?").run(id);
}
