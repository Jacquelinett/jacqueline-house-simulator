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
 *   GET  /api/stats     -> public JSON: per-activity all-time totals + rolling daily averages (color-coded)
 *   PUT  /api/stats     -> (secret required) House Simulator pushes this on a slow cadence (startup + hourly)
 *   GET  /api/period-stats -> public JSON: goal progress + outcomes + activity totals for 4 fixed windows
 *                             (This Week/Last Week/This Month/Last Month) — the viewer has no way to run
 *                             its own arbitrary-date-range queries, so it picks from this fixed list
 *                             instead of a free date picker
 *   PUT  /api/period-stats -> (secret required) House Simulator pushes this on the same cadence as /api/stats
 *   GET  /api/yesterday -> public JSON: yesterday's tracked minutes per activity label (a settled, complete
 *                          day, unlike /api/status's today) — backs the viewer Dashboard's Today/Yesterday toggle
 *   PUT  /api/yesterday -> (secret required) House Simulator pushes this on the same cadence as /api/stats
 *   GET  /api/streaks -> public JSON: current streak length per goal id, for today's scheduled goals only —
 *                        House Simulator has the full completion history to compute this; the viewer doesn't
 *   PUT  /api/streaks -> (secret required) House Simulator pushes this on the same cadence as /api/stats
 *   GET  /api/messages  -> (secret required) your in-app inbox reads these
 *   POST /api/messages  -> public: a viewer leaves you a note
 *   DELETE /api/messages/:id -> (secret required) dismiss a message from your inbox
 *   GET  /api/house-layout -> public JSON: {activities, objectTypes, rooms, floors} — the same four things
 *                             House Simulator's own WebSocket protocol sends a connected game client once on
 *                             connect; the viewer has no WebSocket connection at all, so without this it's
 *                             stuck rendering whatever was baked into its own bundle at the last deploy
 *   PUT  /api/house-layout -> (secret required) House Simulator pushes this once at its own startup, and
 *                             whenever the admin tool's "Sync to viewer" button is clicked — NOT on a timer
 *                             and not after every single admin edit (see House Simulator's own
 *                             adminApi.ts/index.ts comments)
 *
 * It never computes anything itself — goal completion, streaks, stats —
 * it just stores and forwards independently-pushed blobs. Whatever's
 * displaying this joins them client-side, the same way it computes a live
 * "Running for X" clock from just a start time instead of polling.
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
  await sqlite.execute(`create table if not exists stats_blob (
    id integer primary key check (id = 1),
    stats_json text not null,
    updated_at text not null
  )`);
  await sqlite.execute(`create table if not exists period_stats_blob (
    id integer primary key check (id = 1),
    period_stats_json text not null,
    updated_at text not null
  )`);
  await sqlite.execute(`create table if not exists yesterday_blob (
    id integer primary key check (id = 1),
    minutes_json text not null,
    updated_at text not null
  )`);
  await sqlite.execute(`create table if not exists streaks_blob (
    id integer primary key check (id = 1),
    streaks_json text not null,
    updated_at text not null
  )`);
  await sqlite.execute(`create table if not exists messages (
    id integer primary key autoincrement,
    author text,
    text text not null,
    created_at text not null
  )`);
  await sqlite.execute(`create table if not exists house_layout_blob (
    id integer primary key check (id = 1),
    layout_json text not null,
    updated_at text not null
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

async function handleGetStats(): Promise<Response> {
  const result = await sqlite.execute("select * from stats_blob where id = 1");
  const row = result.rows[0] as { stats_json: string } | undefined;
  return Response.json(row ? JSON.parse(row.stats_json) : []);
}

async function handlePutStats(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!Array.isArray(body)) return Response.json({ error: "expected a JSON array of stats" }, { status: 400 });

  await sqlite.execute({
    sql: `insert into stats_blob (id, stats_json, updated_at)
          values (1, :statsJson, :updatedAt)
          on conflict(id) do update set
            stats_json = excluded.stats_json,
            updated_at = excluded.updated_at`,
    args: { statsJson: JSON.stringify(body), updatedAt: new Date().toISOString() },
  });

  return Response.json({ ok: true });
}

async function handleGetPeriodStats(): Promise<Response> {
  const result = await sqlite.execute("select * from period_stats_blob where id = 1");
  const row = result.rows[0] as { period_stats_json: string } | undefined;
  return Response.json(row ? JSON.parse(row.period_stats_json) : []);
}

async function handlePutPeriodStats(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!Array.isArray(body)) return Response.json({ error: "expected a JSON array of period stats" }, { status: 400 });

  await sqlite.execute({
    sql: `insert into period_stats_blob (id, period_stats_json, updated_at)
          values (1, :periodStatsJson, :updatedAt)
          on conflict(id) do update set
            period_stats_json = excluded.period_stats_json,
            updated_at = excluded.updated_at`,
    args: { periodStatsJson: JSON.stringify(body), updatedAt: new Date().toISOString() },
  });

  return Response.json({ ok: true });
}

async function handleGetYesterday(): Promise<Response> {
  const result = await sqlite.execute("select * from yesterday_blob where id = 1");
  const row = result.rows[0] as { minutes_json: string } | undefined;
  return Response.json(row ? JSON.parse(row.minutes_json) : {});
}

async function handlePutYesterday(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "expected a JSON object of label -> minutes" }, { status: 400 });
  }

  await sqlite.execute({
    sql: `insert into yesterday_blob (id, minutes_json, updated_at)
          values (1, :minutesJson, :updatedAt)
          on conflict(id) do update set
            minutes_json = excluded.minutes_json,
            updated_at = excluded.updated_at`,
    args: { minutesJson: JSON.stringify(body), updatedAt: new Date().toISOString() },
  });

  return Response.json({ ok: true });
}

async function handleGetStreaks(): Promise<Response> {
  const result = await sqlite.execute("select * from streaks_blob where id = 1");
  const row = result.rows[0] as { streaks_json: string } | undefined;
  return Response.json(row ? JSON.parse(row.streaks_json) : {});
}

async function handlePutStreaks(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "expected a JSON object of goal id -> streak length" }, { status: 400 });
  }

  await sqlite.execute({
    sql: `insert into streaks_blob (id, streaks_json, updated_at)
          values (1, :streaksJson, :updatedAt)
          on conflict(id) do update set
            streaks_json = excluded.streaks_json,
            updated_at = excluded.updated_at`,
    args: { streaksJson: JSON.stringify(body), updatedAt: new Date().toISOString() },
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

async function handleGetHouseLayout(): Promise<Response> {
  const result = await sqlite.execute("select * from house_layout_blob where id = 1");
  const row = result.rows[0] as { layout_json: string } | undefined;
  return Response.json(row ? JSON.parse(row.layout_json) : { activities: [], objectTypes: {}, rooms: [], floors: [] });
}

async function handlePutHouseLayout(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "invalid JSON body" }, { status: 400 });

  await sqlite.execute({
    sql: `insert into house_layout_blob (id, layout_json, updated_at)
          values (1, :layoutJson, :updatedAt)
          on conflict(id) do update set
            layout_json = excluded.layout_json,
            updated_at = excluded.updated_at`,
    args: { layoutJson: JSON.stringify(body), updatedAt: new Date().toISOString() },
  });

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

  if (method === "GET" && pathname === "/api/stats") {
    return handleGetStats();
  }

  if (method === "PUT" && pathname === "/api/stats") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutStats(req);
  }

  if (method === "GET" && pathname === "/api/period-stats") {
    return handleGetPeriodStats();
  }

  if (method === "PUT" && pathname === "/api/period-stats") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutPeriodStats(req);
  }

  if (method === "GET" && pathname === "/api/yesterday") {
    return handleGetYesterday();
  }

  if (method === "PUT" && pathname === "/api/yesterday") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutYesterday(req);
  }

  if (method === "GET" && pathname === "/api/streaks") {
    return handleGetStreaks();
  }

  if (method === "PUT" && pathname === "/api/streaks") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutStreaks(req);
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

  if (method === "GET" && pathname === "/api/house-layout") {
    return handleGetHouseLayout();
  }

  if (method === "PUT" && pathname === "/api/house-layout") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutHouseLayout(req);
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
