/**
 * Paste this whole file into a val.town HTTP val (e.g. named
 * "houseSimulatorStatus"). Pure data API, deliberately dumb — no viewer page
 * here (val.town caps a val's own source at 80,000 characters, nowhere near
 * enough for an actual bundled Pixi app). The real viewer is a separate
 * static site (built from viewer.html/src/viewer-main.ts via
 * vite.viewer.config.ts, meant for GitHub Pages) that just fetches these
 * same endpoints cross-origin — val.town already sends permissive CORS by
 * default, confirmed against this val.
 *
 *   GET  /api/status    -> public JSON: what's currently running + today's tracked minutes per label
 *   PUT  /api/status    -> (secret required) House Simulator pushes this on activity change
 *   GET  /api/goals     -> public JSON: your raw goal definitions (targets/schedules, not progress)
 *   PUT  /api/goals     -> (secret required) House Simulator pushes this whenever goals change
 *   GET  /api/messages  -> (secret required) your in-app inbox reads these
 *   POST /api/messages  -> public: a viewer leaves you a note
 *   DELETE /api/messages/:id -> (secret required) dismiss a message from your inbox
 *
 * It never computes goal completion itself — it just stores and forwards
 * two independently-updated blobs (goal definitions, and today's tracked
 * minutes per activity label). Whatever's displaying this joins the two
 * client-side, the same way it computes a live "Running for X" clock from
 * just a start time instead of polling.
 *
 * Before using: open this val's settings sidebar in val.town and add an
 * Environment Variable named HOUSE_SIM_SECRET with a long random value.
 * Put that same value, and this val's URL, into House Simulator's Settings.
 */

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

const MAX_MESSAGE_LENGTH = 500;
const MAX_AUTHOR_LENGTH = 50;

async function ensureSchema() {
  await sqlite.execute(`create table if not exists status (
    id integer primary key check (id = 1),
    activity_label text,
    started_at text,
    today_minutes_json text,
    updated_at text not null
  )`);
  // CREATE TABLE IF NOT EXISTS is a no-op once the table already exists —
  // harmless for a brand new val, but a val whose `status` table predates
  // today_minutes_json (it used to be called goals_json) would otherwise
  // keep missing this column forever. ALTER TABLE ADD COLUMN is the actual
  // migration; it only fails if the column's already there, which is fine
  // to ignore.
  await sqlite.execute(`alter table status add column today_minutes_json text`).catch(() => {});
  await sqlite.execute(`create table if not exists goals_blob (
    id integer primary key check (id = 1),
    goals_json text not null,
    updated_at text not null
  )`);
  await sqlite.execute(`create table if not exists messages (
    id integer primary key autoincrement,
    author text,
    text text not null,
    created_at text not null
  )`);
}

function isAuthorized(req: Request): boolean {
  const secret = Deno.env.get("HOUSE_SIM_SECRET");
  if (!secret) return false;
  return req.headers.get("Authorization") === `Bearer ${secret}`;
}

async function handleGetStatus(): Promise<Response> {
  const result = await sqlite.execute("select * from status where id = 1");
  const row = result.rows[0] as
    | { activity_label: string | null; started_at: string | null; today_minutes_json: string | null; updated_at: string }
    | undefined;

  if (!row) {
    return Response.json({ activityLabel: null, startedAt: null, todayMinutesByLabel: {}, updatedAt: null });
  }

  return Response.json({
    activityLabel: row.activity_label,
    startedAt: row.started_at,
    todayMinutesByLabel: row.today_minutes_json ? JSON.parse(row.today_minutes_json) : {},
    updatedAt: row.updated_at,
  });
}

async function handlePutStatus(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "invalid JSON body" }, { status: 400 });

  const activityLabel: string | null = body.activityLabel ?? null;
  const startedAt: string | null = body.startedAt ?? null;
  const todayMinutesByLabel: Record<string, number> =
    body.todayMinutesByLabel && typeof body.todayMinutesByLabel === "object" ? body.todayMinutesByLabel : {};

  await sqlite.execute({
    sql: `insert into status (id, activity_label, started_at, today_minutes_json, updated_at)
          values (1, :activityLabel, :startedAt, :todayMinutesJson, :updatedAt)
          on conflict(id) do update set
            activity_label = excluded.activity_label,
            started_at = excluded.started_at,
            today_minutes_json = excluded.today_minutes_json,
            updated_at = excluded.updated_at`,
    args: {
      activityLabel,
      startedAt,
      todayMinutesJson: JSON.stringify(todayMinutesByLabel),
      updatedAt: new Date().toISOString(),
    },
  });

  return Response.json({ ok: true });
}

async function handleGetGoals(): Promise<Response> {
  const result = await sqlite.execute("select * from goals_blob where id = 1");
  const row = result.rows[0] as { goals_json: string } | undefined;
  return Response.json(row ? JSON.parse(row.goals_json) : []);
}

async function handlePutGoals(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!Array.isArray(body)) return Response.json({ error: "expected a JSON array of goals" }, { status: 400 });

  await sqlite.execute({
    sql: `insert into goals_blob (id, goals_json, updated_at)
          values (1, :goalsJson, :updatedAt)
          on conflict(id) do update set
            goals_json = excluded.goals_json,
            updated_at = excluded.updated_at`,
    args: { goalsJson: JSON.stringify(body), updatedAt: new Date().toISOString() },
  });

  return Response.json({ ok: true });
}

async function handleGetMessages(): Promise<Response> {
  const result = await sqlite.execute("select * from messages order by id desc limit 200");
  return Response.json(result.rows);
}

async function handlePostMessage(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const author = typeof body?.author === "string" ? body.author.trim() : "";

  if (!text) return Response.json({ error: "message text is required" }, { status: 400 });
  if (text.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: `message too long (max ${MAX_MESSAGE_LENGTH} chars)` }, { status: 400 });
  }
  if (author.length > MAX_AUTHOR_LENGTH) {
    return Response.json({ error: `name too long (max ${MAX_AUTHOR_LENGTH} chars)` }, { status: 400 });
  }

  await sqlite.execute({
    sql: "insert into messages (author, text, created_at) values (:author, :text, :createdAt)",
    args: { author: author || null, text, createdAt: new Date().toISOString() },
  });

  return Response.json({ ok: true });
}

async function handleDeleteMessage(id: string): Promise<Response> {
  await sqlite.execute({ sql: "delete from messages where id = :id", args: { id: Number(id) } });
  return Response.json({ ok: true });
}

export default async function (req: Request): Promise<Response> {
  await ensureSchema();

  const url = new URL(req.url);
  const { pathname } = url;
  const { method } = req;

  if (method === "GET" && pathname === "/") {
    return Response.json({ ok: true, service: "House Simulator status API" });
  }

  if (method === "GET" && pathname === "/api/status") {
    return handleGetStatus();
  }

  if (method === "PUT" && pathname === "/api/status") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutStatus(req);
  }

  if (method === "GET" && pathname === "/api/goals") {
    return handleGetGoals();
  }

  if (method === "PUT" && pathname === "/api/goals") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutGoals(req);
  }

  if (method === "GET" && pathname === "/api/messages") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleGetMessages();
  }

  if (method === "POST" && pathname === "/api/messages") {
    return handlePostMessage(req);
  }

  const deleteMatch = pathname.match(/^\/api\/messages\/(\d+)$/);
  if (method === "DELETE" && deleteMatch) {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleDeleteMessage(deleteMatch[1]);
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
