/**
 * Paste this whole file into a val.town HTTP val (e.g. named
 * "houseSimulatorStatus"). It serves three things from one URL:
 *
 *   GET  /              -> a plain HTML viewer page (share this link with friends)
 *   GET  /api/status    -> public JSON: what's currently running + today's goal progress
 *   PUT  /api/status    -> (secret required) House Simulator pushes its status here
 *   GET  /api/messages  -> (secret required) your in-app inbox reads these
 *   POST /api/messages  -> public: a viewer leaves you a note
 *   DELETE /api/messages/:id -> (secret required) dismiss a message from your inbox
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
    goals_json text,
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

interface GoalProgress {
  activityLabel: string;
  targetMinutes: number;
  minutes: number;
  done: boolean;
}

async function handleGetStatus(): Promise<Response> {
  const result = await sqlite.execute("select * from status where id = 1");
  const row = result.rows[0] as
    | { activity_label: string | null; started_at: string | null; goals_json: string | null; updated_at: string }
    | undefined;

  if (!row) {
    return Response.json({ activityLabel: null, startedAt: null, goals: [], updatedAt: null });
  }

  return Response.json({
    activityLabel: row.activity_label,
    startedAt: row.started_at,
    goals: row.goals_json ? (JSON.parse(row.goals_json) as GoalProgress[]) : [],
    updatedAt: row.updated_at,
  });
}

async function handlePutStatus(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "invalid JSON body" }, { status: 400 });

  const activityLabel: string | null = body.activityLabel ?? null;
  const startedAt: string | null = body.startedAt ?? null;
  const goals: GoalProgress[] = Array.isArray(body.goals) ? body.goals : [];

  await sqlite.execute({
    sql: `insert into status (id, activity_label, started_at, goals_json, updated_at)
          values (1, :activityLabel, :startedAt, :goalsJson, :updatedAt)
          on conflict(id) do update set
            activity_label = excluded.activity_label,
            started_at = excluded.started_at,
            goals_json = excluded.goals_json,
            updated_at = excluded.updated_at`,
    args: {
      activityLabel,
      startedAt,
      goalsJson: JSON.stringify(goals),
      updatedAt: new Date().toISOString(),
    },
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

function viewerHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>What's Jacqueline doing?</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1a1a; color: #eee; max-width: 480px; margin: 40px auto; padding: 0 16px; }
  h1 { font-size: 20px; }
  #status { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  #activity { font-size: 18px; font-weight: 600; }
  #elapsed { opacity: 0.7; font-size: 14px; }
  .goal-row { display: flex; gap: 8px; align-items: center; font-size: 14px; margin-top: 6px; }
  .goal-done { text-decoration: line-through; opacity: 0.6; }
  textarea, input { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.08); color: #eee; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 8px; font-size: 14px; margin-bottom: 8px; }
  button { background: rgba(255,255,255,0.12); color: #eee; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 8px 14px; cursor: pointer; }
  button:hover { background: rgba(255,255,255,0.2); }
  #sendStatus { font-size: 13px; opacity: 0.7; margin-top: 6px; }
</style>
</head>
<body>
  <h1>What's Jacqueline doing?</h1>
  <div id="status">
    <div id="activity">Loading...</div>
    <div id="elapsed"></div>
    <div id="goals"></div>
  </div>

  <h2>Leave a note</h2>
  <input id="author" placeholder="Your name (optional)" maxlength="${MAX_AUTHOR_LENGTH}" />
  <textarea id="text" rows="3" placeholder="wow you actually lifted today, nice" maxlength="${MAX_MESSAGE_LENGTH}"></textarea>
  <button id="send">Send</button>
  <div id="sendStatus"></div>

<script>
  let startedAtMs = null;

  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60).toString().padStart(hh > 0 ? 2 : 1, "0");
    const ss = (s % 60).toString().padStart(2, "0");
    return hh > 0 ? hh + ":" + mm + ":" + ss : mm + ":" + ss;
  }

  function fmtMinutes(min) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? h + "h " + m + "m" : m + "m";
  }

  async function refreshStatus() {
    const res = await fetch("/api/status");
    const data = await res.json();

    const activityEl = document.getElementById("activity");
    const goalsEl = document.getElementById("goals");

    if (data.activityLabel) {
      activityEl.textContent = "Currently: " + data.activityLabel;
      startedAtMs = new Date(data.startedAt).getTime();
    } else {
      activityEl.textContent = "Not currently doing anything tracked";
      startedAtMs = null;
    }

    goalsEl.innerHTML = "";
    for (const g of data.goals || []) {
      const row = document.createElement("div");
      row.className = "goal-row" + (g.done ? " goal-done" : "");
      row.textContent = (g.done ? "☑" : "☐") + " " + g.activityLabel + " — " +
        fmtMinutes(g.minutes) + " / " + fmtMinutes(g.targetMinutes);
      goalsEl.appendChild(row);
    }
  }

  function tickElapsed() {
    const el = document.getElementById("elapsed");
    el.textContent = startedAtMs ? "Running for " + fmtElapsed(Date.now() - startedAtMs) : "";
  }

  refreshStatus();
  setInterval(refreshStatus, 2 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshStatus(); });
  setInterval(tickElapsed, 1000);

  document.getElementById("send").onclick = async () => {
    const text = document.getElementById("text").value.trim();
    const author = document.getElementById("author").value.trim();
    const statusEl = document.getElementById("sendStatus");
    if (!text) return;

    const btn = document.getElementById("send");
    btn.disabled = true;
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, author }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "failed to send");
      document.getElementById("text").value = "";
      statusEl.textContent = "Sent!";
    } catch (err) {
      statusEl.textContent = "Error: " + err.message;
    } finally {
      btn.disabled = false;
    }
  };
</script>
</body>
</html>`;
}

export default async function (req: Request): Promise<Response> {
  await ensureSchema();

  const url = new URL(req.url);
  const { pathname } = url;
  const { method } = req;

  if (method === "GET" && pathname === "/") {
    return new Response(viewerHtml(), { headers: { "Content-Type": "text/html" } });
  }

  if (method === "GET" && pathname === "/api/status") {
    return handleGetStatus();
  }

  if (method === "PUT" && pathname === "/api/status") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutStatus(req);
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
