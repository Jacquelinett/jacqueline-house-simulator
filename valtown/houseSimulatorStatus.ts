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
 * Every per-character endpoint below (status/goals/stats/period-stats/
 * yesterday/streaks) is keyed by `character_id`, not a single hardcoded
 * row — any character the admin tool has published (House Simulator's own
 * `characters.publish_to_viewer`) gets its own row, independent of every
 * other published character. `GET` takes `?character=<id>`; `PUT` always
 * carries `characterId`/`characterName` in the body (House Simulator
 * resolves both server-side before pushing).
 *
 *   GET  /api/all -> public JSON: { characters, status, goals, stats, periodStats, yesterday, streaks, workoutToday, wgerSummary }
 *                    — everything above, for every published character at once, each of the latter eight
 *                    keyed by character id. This is the ONLY endpoint the viewer itself calls on a
 *                    refresh (startup, the poll interval, or its manual refresh button) — one request
 *                    gets it everything, so switching which character it's showing is a pure
 *                    client-side re-render against already-fetched data, never a new fetch. The
 *                    individual per-character GET endpoints below still exist (harmless to leave, and
 *                    still handy for debugging one character's blob directly), but nothing in this
 *                    repo calls them anymore.
 *   GET  /api/characters -> public JSON: [{id, name, spriteName}, ...] for every character ever
 *                            published — lets the viewer show a picker instead of hardcoding whose
 *                            data to show; spriteName is House Simulator's own sprite-key resolution
 *                            input (null means "use the shared default art"), carried through so the
 *                            viewer can resolve the same per-character overlay art the desktop app does
 *   GET  /api/status?character=<id>    -> public JSON: what that character is currently running + today's
 *                                          tracked minutes per label
 *   PUT  /api/status    -> (secret required) House Simulator pushes this on activity change
 *   GET  /api/goals?character=<id>     -> public JSON: that character's raw goal definitions (targets/
 *                                          schedules, not progress)
 *   PUT  /api/goals     -> (secret required) House Simulator pushes this whenever goals change
 *   GET  /api/stats?character=<id>     -> public JSON: per-activity all-time totals + rolling daily
 *                                          averages (color-coded)
 *   PUT  /api/stats     -> (secret required) House Simulator pushes this on a slow cadence (startup + hourly)
 *   GET  /api/period-stats?character=<id> -> public JSON: goal progress + outcomes + activity totals for
 *                             4 fixed windows (This Week/Last Week/This Month/Last Month) — the viewer has
 *                             no way to run its own arbitrary-date-range queries, so it picks from this
 *                             fixed list instead of a free date picker
 *   PUT  /api/period-stats -> (secret required) House Simulator pushes this on the same cadence as /api/stats
 *   GET  /api/yesterday?character=<id> -> public JSON: yesterday's tracked minutes per activity label (a
 *                          settled, complete day, unlike /api/status's today) — backs the viewer
 *                          Dashboard's Today/Yesterday toggle
 *   PUT  /api/yesterday -> (secret required) House Simulator pushes this on the same cadence as /api/stats
 *   GET  /api/streaks?character=<id>   -> public JSON: current streak length per goal id, for that
 *                        character's today-scheduled goals only — House Simulator has the full
 *                        completion history to compute this; the viewer doesn't
 *   PUT  /api/streaks -> (secret required) House Simulator pushes this on the same cadence as /api/stats
 *   GET  /api/workout-today?character=<id> -> public JSON: that character's logged workout sessions for
 *                        the real current day (real wger data for the wger-linked character, empty for
 *                        everyone else — see server/workouts.ts) — an empty array means "nothing logged
 *                        (yet)," not "unavailable"
 *   PUT  /api/workout-today -> (secret required) House Simulator pushes this on the same cadence as
 *                        /api/stats (hourly) — unlike /api/yesterday or /api/streaks it never self-skips
 *                        once already pushed "for today," since a workout can still be logged later the
 *                        same day
 *   GET  /api/wger-summary?character=<id> -> public JSON: { lifetimeStats, personalRecords, recentDays } —
 *                        wger's own computed lifetime totals/streaks and auto-detected personal records (1RM
 *                        estimate included), plus the last 7 days' exercise summary + mood (DaySummary[], not
 *                        the exact-times/notes RecentSession shape — see House Simulator's pushWgerSummary
 *                        comment on why that precision stays desktop-only), for the wger-linked character;
 *                        null/[] for everyone else.
 *   PUT  /api/wger-summary -> (secret required) House Simulator pushes this on the same cadence as
 *                        /api/stats (hourly)
 *   GET  /api/messages?character=<id> -> (secret required) that character's own inbox only — House
 *                        Simulator's WS connection supplies its own characterId server-side, same as
 *                        every per-character query
 *   POST /api/messages  -> public: a viewer leaves a note for whichever character they were viewing
 *                        (`characterId` in the body) — a note left while viewing Kevin shows up in
 *                        Kevin's inbox only, never Jacqueline's
 *   DELETE /api/messages/:id?character=<id> -> (secret required) dismiss a message from your OWN inbox —
 *                        scoped by character_id server-side (not just by id), so one character's device
 *                        can't delete a note left for a different character just by guessing/knowing its id
 *   GET  /api/house-layout -> public JSON: {activities, objectTypes, rooms, floors} — the same four things
 *                             House Simulator's own WebSocket protocol sends a connected game client once on
 *                             connect; the viewer has no WebSocket connection at all, so without this it's
 *                             stuck rendering whatever was baked into its own bundle at the last deploy.
 *                             Global, not per-character — one shared house, not one per published character.
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

/**
 * One-time reset from the old single-row-per-table schema (`id integer
 * primary key check (id = 1)`, Jacqueline-only) to per-character rows
 * (`character_id text primary key`) — detected by whether `character_id`
 * is actually a column yet, same spirit as House Simulator's own
 * columnType() check. None of these six tables hold anything precious:
 * every value here is re-derivable from House Simulator's own SQLite (the
 * real source of truth), so a plain drop + recreate is simpler than
 * migrating the old singleton row across, and self-heals on the very next
 * push (server startup, an activity change, or "Sync to viewer").
 */
async function migrateToPerCharacter(table: string, createSql: string): Promise<void> {
  const existing = await sqlite.execute({
    sql: "select name from sqlite_master where type = 'table' and name = :table",
    args: { table },
  });
  if (existing.rows.length > 0) {
    const info = await sqlite.execute(`pragma table_info(${table})`);
    const hasCharacterId = info.rows.some((r: any) => r.name === "character_id");
    if (!hasCharacterId) await sqlite.execute(`drop table ${table}`);
  }
  await sqlite.execute(createSql);
}

async function ensureSchema() {
  await migrateToPerCharacter(
    "status",
    `create table if not exists status (
      character_id text primary key,
      character_name text not null,
      character_sprite_name text,
      activity_label text,
      started_at text,
      today_minutes_json text,
      updated_at text not null
    )`,
  );
  // character_sprite_name added after the table already existed on some
  // deployments — CREATE TABLE IF NOT EXISTS above is a no-op for those
  // (the same val.town schema-migration gotcha CLAUDE.md documents), so
  // an explicit ADD COLUMN is needed too. Only fails if the column's
  // already there.
  await sqlite.execute("alter table status add column character_sprite_name text").catch(() => {});
  await migrateToPerCharacter(
    "goals_blob",
    `create table if not exists goals_blob (
      character_id text primary key,
      character_name text not null,
      goals_json text not null,
      updated_at text not null
    )`,
  );
  await migrateToPerCharacter(
    "stats_blob",
    `create table if not exists stats_blob (
      character_id text primary key,
      character_name text not null,
      stats_json text not null,
      updated_at text not null
    )`,
  );
  await migrateToPerCharacter(
    "period_stats_blob",
    `create table if not exists period_stats_blob (
      character_id text primary key,
      character_name text not null,
      period_stats_json text not null,
      updated_at text not null
    )`,
  );
  await migrateToPerCharacter(
    "yesterday_blob",
    `create table if not exists yesterday_blob (
      character_id text primary key,
      character_name text not null,
      minutes_json text not null,
      updated_at text not null
    )`,
  );
  await migrateToPerCharacter(
    "streaks_blob",
    `create table if not exists streaks_blob (
      character_id text primary key,
      character_name text not null,
      streaks_json text not null,
      updated_at text not null
    )`,
  );
  await migrateToPerCharacter(
    "workout_today_blob",
    `create table if not exists workout_today_blob (
      character_id text primary key,
      character_name text not null,
      sessions_json text not null,
      updated_at text not null
    )`,
  );
  await migrateToPerCharacter(
    "wger_summary_blob",
    `create table if not exists wger_summary_blob (
      character_id text primary key,
      character_name text not null,
      lifetime_stats_json text,
      personal_records_json text not null,
      recent_days_json text not null default '[]',
      updated_at text not null
    )`,
  );
  // recent_days_json added after this table already existed on the live
  // val (it shipped with just lifetime_stats_json/personal_records_json
  // first) — same gotcha as character_sprite_name above: CREATE TABLE IF
  // NOT EXISTS is a no-op once the table's already there, so the new
  // column needs an explicit ADD COLUMN too. SQLite backfills a non-NULL
  // DEFAULT onto every existing row when adding a NOT NULL column (unlike
  // some other databases), so every row — old or new — gets a real '[]'
  // here, not NULL; the next pushWgerSummary() call overwrites it with
  // the real recent-days data regardless.
  await sqlite.execute("alter table wger_summary_blob add column recent_days_json text not null default '[]'").catch(() => {});
  await sqlite.execute(`create table if not exists messages (
    id integer primary key autoincrement,
    author text,
    text text not null,
    character_id text,
    created_at text not null
  )`);
  // Added after some deployments already had this table — CREATE TABLE IF
  // NOT EXISTS above is a no-op for those, same gotcha documented at the
  // top of this file. Existing rows keep character_id null (visible to no
  // one specifically now that the inbox is per-character — see
  // handleGetMessages), rather than being retroactively guessed at.
  await sqlite.execute("alter table messages add column character_id text").catch(() => {});
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

function characterIdFrom(url: URL): string | null {
  return url.searchParams.get("character");
}

async function handleGetCharacters(): Promise<Response> {
  const result = await sqlite.execute("select character_id, character_name, character_sprite_name from status order by character_name");
  return Response.json(result.rows.map((r: any) => ({ id: r.character_id, name: r.character_name, spriteName: r.character_sprite_name })));
}

/**
 * Everything the viewer needs, for every published character, in one
 * request — see this file's own top-of-file doc comment on /api/all for
 * why. `status` doubles as the character directory (same query
 * handleGetCharacters runs): any character with a status row has been
 * published, and every other table is keyed the same way, so a character
 * with no row yet in e.g. goals_blob just gets an empty/default value
 * rather than being left out of that map entirely.
 */
async function handleGetAll(): Promise<Response> {
  const [statusRows, goalsRows, statsRows, periodStatsRows, yesterdayRows, streaksRows, workoutTodayRows, wgerSummaryRows] = await Promise.all([
    sqlite.execute("select * from status"),
    sqlite.execute("select character_id, goals_json from goals_blob"),
    sqlite.execute("select character_id, stats_json from stats_blob"),
    sqlite.execute("select character_id, period_stats_json from period_stats_blob"),
    sqlite.execute("select character_id, minutes_json from yesterday_blob"),
    sqlite.execute("select character_id, streaks_json from streaks_blob"),
    sqlite.execute("select character_id, sessions_json from workout_today_blob"),
    sqlite.execute("select character_id, lifetime_stats_json, personal_records_json, recent_days_json from wger_summary_blob"),
  ]);

  const characters: { id: string; name: string; spriteName: string | null }[] = [];
  const status: Record<string, { activityLabel: string | null; startedAt: string | null; todayMinutesByLabel: Record<string, number> }> = {};
  for (const r of statusRows.rows as any[]) {
    characters.push({ id: r.character_id, name: r.character_name, spriteName: r.character_sprite_name });
    status[r.character_id] = {
      activityLabel: r.activity_label,
      startedAt: r.started_at,
      todayMinutesByLabel: r.today_minutes_json ? JSON.parse(r.today_minutes_json) : {},
    };
  }
  characters.sort((a, b) => a.name.localeCompare(b.name));

  const goals: Record<string, unknown> = {};
  for (const r of goalsRows.rows as any[]) goals[r.character_id] = JSON.parse(r.goals_json);

  const stats: Record<string, unknown> = {};
  for (const r of statsRows.rows as any[]) stats[r.character_id] = JSON.parse(r.stats_json);

  const periodStats: Record<string, unknown> = {};
  for (const r of periodStatsRows.rows as any[]) periodStats[r.character_id] = JSON.parse(r.period_stats_json);

  const yesterday: Record<string, unknown> = {};
  for (const r of yesterdayRows.rows as any[]) yesterday[r.character_id] = JSON.parse(r.minutes_json);

  const streaks: Record<string, unknown> = {};
  for (const r of streaksRows.rows as any[]) streaks[r.character_id] = JSON.parse(r.streaks_json);

  const workoutToday: Record<string, unknown> = {};
  for (const r of workoutTodayRows.rows as any[]) workoutToday[r.character_id] = JSON.parse(r.sessions_json);

  const wgerSummary: Record<string, { lifetimeStats: unknown; personalRecords: unknown; recentDays: unknown }> = {};
  for (const r of wgerSummaryRows.rows as any[]) {
    wgerSummary[r.character_id] = {
      lifetimeStats: r.lifetime_stats_json ? JSON.parse(r.lifetime_stats_json) : null,
      personalRecords: JSON.parse(r.personal_records_json),
      recentDays: JSON.parse(r.recent_days_json),
    };
  }

  return Response.json({ characters, status, goals, stats, periodStats, yesterday, streaks, workoutToday, wgerSummary });
}

async function handleGetStatus(characterId: string | null): Promise<Response> {
  const result = characterId
    ? await sqlite.execute({ sql: "select * from status where character_id = :characterId", args: { characterId } })
    : { rows: [] };
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
  if (!body?.characterId || !body?.characterName) return Response.json({ error: "characterId/characterName required" }, { status: 400 });

  const activityLabel: string | null = body.activityLabel ?? null;
  const startedAt: string | null = body.startedAt ?? null;
  const characterSpriteName: string | null = body.characterSpriteName ?? null;
  const todayMinutesByLabel: Record<string, number> =
    body.todayMinutesByLabel && typeof body.todayMinutesByLabel === "object" ? body.todayMinutesByLabel : {};

  await sqlite.execute({
    sql: `insert into status (character_id, character_name, character_sprite_name, activity_label, started_at, today_minutes_json, updated_at)
          values (:characterId, :characterName, :characterSpriteName, :activityLabel, :startedAt, :todayMinutesJson, :updatedAt)
          on conflict(character_id) do update set
            character_name = excluded.character_name,
            character_sprite_name = excluded.character_sprite_name,
            activity_label = excluded.activity_label,
            started_at = excluded.started_at,
            today_minutes_json = excluded.today_minutes_json,
            updated_at = excluded.updated_at`,
    args: {
      characterId: body.characterId,
      characterName: body.characterName,
      characterSpriteName,
      activityLabel,
      startedAt,
      todayMinutesJson: JSON.stringify(todayMinutesByLabel),
      updatedAt: new Date().toISOString(),
    },
  });

  return Response.json({ ok: true });
}

async function handleGetGoals(characterId: string | null): Promise<Response> {
  const result = characterId
    ? await sqlite.execute({ sql: "select goals_json from goals_blob where character_id = :characterId", args: { characterId } })
    : { rows: [] };
  const row = result.rows[0] as { goals_json: string } | undefined;
  return Response.json(row ? JSON.parse(row.goals_json) : []);
}

async function handlePutGoals(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.characterId || !body?.characterName || !Array.isArray(body.goals)) {
    return Response.json({ error: "expected { characterId, characterName, goals: [...] }" }, { status: 400 });
  }

  await sqlite.execute({
    sql: `insert into goals_blob (character_id, character_name, goals_json, updated_at)
          values (:characterId, :characterName, :goalsJson, :updatedAt)
          on conflict(character_id) do update set
            character_name = excluded.character_name,
            goals_json = excluded.goals_json,
            updated_at = excluded.updated_at`,
    args: {
      characterId: body.characterId,
      characterName: body.characterName,
      goalsJson: JSON.stringify(body.goals),
      updatedAt: new Date().toISOString(),
    },
  });

  return Response.json({ ok: true });
}

async function handleGetStats(characterId: string | null): Promise<Response> {
  const result = characterId
    ? await sqlite.execute({ sql: "select stats_json from stats_blob where character_id = :characterId", args: { characterId } })
    : { rows: [] };
  const row = result.rows[0] as { stats_json: string } | undefined;
  return Response.json(row ? JSON.parse(row.stats_json) : []);
}

async function handlePutStats(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.characterId || !body?.characterName || !Array.isArray(body.stats)) {
    return Response.json({ error: "expected { characterId, characterName, stats: [...] }" }, { status: 400 });
  }

  await sqlite.execute({
    sql: `insert into stats_blob (character_id, character_name, stats_json, updated_at)
          values (:characterId, :characterName, :statsJson, :updatedAt)
          on conflict(character_id) do update set
            character_name = excluded.character_name,
            stats_json = excluded.stats_json,
            updated_at = excluded.updated_at`,
    args: {
      characterId: body.characterId,
      characterName: body.characterName,
      statsJson: JSON.stringify(body.stats),
      updatedAt: new Date().toISOString(),
    },
  });

  return Response.json({ ok: true });
}

async function handleGetPeriodStats(characterId: string | null): Promise<Response> {
  const result = characterId
    ? await sqlite.execute({
        sql: "select period_stats_json from period_stats_blob where character_id = :characterId",
        args: { characterId },
      })
    : { rows: [] };
  const row = result.rows[0] as { period_stats_json: string } | undefined;
  return Response.json(row ? JSON.parse(row.period_stats_json) : []);
}

async function handlePutPeriodStats(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.characterId || !body?.characterName || !Array.isArray(body.periodStats)) {
    return Response.json({ error: "expected { characterId, characterName, periodStats: [...] }" }, { status: 400 });
  }

  await sqlite.execute({
    sql: `insert into period_stats_blob (character_id, character_name, period_stats_json, updated_at)
          values (:characterId, :characterName, :periodStatsJson, :updatedAt)
          on conflict(character_id) do update set
            character_name = excluded.character_name,
            period_stats_json = excluded.period_stats_json,
            updated_at = excluded.updated_at`,
    args: {
      characterId: body.characterId,
      characterName: body.characterName,
      periodStatsJson: JSON.stringify(body.periodStats),
      updatedAt: new Date().toISOString(),
    },
  });

  return Response.json({ ok: true });
}

async function handleGetYesterday(characterId: string | null): Promise<Response> {
  const result = characterId
    ? await sqlite.execute({ sql: "select minutes_json from yesterday_blob where character_id = :characterId", args: { characterId } })
    : { rows: [] };
  const row = result.rows[0] as { minutes_json: string } | undefined;
  return Response.json(row ? JSON.parse(row.minutes_json) : {});
}

async function handlePutYesterday(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.characterId || !body?.characterName || !body.minutesByLabel || typeof body.minutesByLabel !== "object") {
    return Response.json({ error: "expected { characterId, characterName, minutesByLabel: {...} }" }, { status: 400 });
  }

  await sqlite.execute({
    sql: `insert into yesterday_blob (character_id, character_name, minutes_json, updated_at)
          values (:characterId, :characterName, :minutesJson, :updatedAt)
          on conflict(character_id) do update set
            character_name = excluded.character_name,
            minutes_json = excluded.minutes_json,
            updated_at = excluded.updated_at`,
    args: {
      characterId: body.characterId,
      characterName: body.characterName,
      minutesJson: JSON.stringify(body.minutesByLabel),
      updatedAt: new Date().toISOString(),
    },
  });

  return Response.json({ ok: true });
}

async function handleGetStreaks(characterId: string | null): Promise<Response> {
  const result = characterId
    ? await sqlite.execute({ sql: "select streaks_json from streaks_blob where character_id = :characterId", args: { characterId } })
    : { rows: [] };
  const row = result.rows[0] as { streaks_json: string } | undefined;
  return Response.json(row ? JSON.parse(row.streaks_json) : {});
}

async function handlePutStreaks(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.characterId || !body?.characterName || !body.streaksByGoalId || typeof body.streaksByGoalId !== "object") {
    return Response.json({ error: "expected { characterId, characterName, streaksByGoalId: {...} }" }, { status: 400 });
  }

  await sqlite.execute({
    sql: `insert into streaks_blob (character_id, character_name, streaks_json, updated_at)
          values (:characterId, :characterName, :streaksJson, :updatedAt)
          on conflict(character_id) do update set
            character_name = excluded.character_name,
            streaks_json = excluded.streaks_json,
            updated_at = excluded.updated_at`,
    args: {
      characterId: body.characterId,
      characterName: body.characterName,
      streaksJson: JSON.stringify(body.streaksByGoalId),
      updatedAt: new Date().toISOString(),
    },
  });

  return Response.json({ ok: true });
}

async function handleGetWorkoutToday(characterId: string | null): Promise<Response> {
  const result = characterId
    ? await sqlite.execute({ sql: "select sessions_json from workout_today_blob where character_id = :characterId", args: { characterId } })
    : { rows: [] };
  const row = result.rows[0] as { sessions_json: string } | undefined;
  return Response.json(row ? JSON.parse(row.sessions_json) : []);
}

async function handlePutWorkoutToday(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.characterId || !body?.characterName || !Array.isArray(body.sessions)) {
    return Response.json({ error: "expected { characterId, characterName, sessions: [...] }" }, { status: 400 });
  }

  await sqlite.execute({
    sql: `insert into workout_today_blob (character_id, character_name, sessions_json, updated_at)
          values (:characterId, :characterName, :sessionsJson, :updatedAt)
          on conflict(character_id) do update set
            character_name = excluded.character_name,
            sessions_json = excluded.sessions_json,
            updated_at = excluded.updated_at`,
    args: {
      characterId: body.characterId,
      characterName: body.characterName,
      sessionsJson: JSON.stringify(body.sessions),
      updatedAt: new Date().toISOString(),
    },
  });

  return Response.json({ ok: true });
}

async function handleGetWgerSummary(characterId: string | null): Promise<Response> {
  const result = characterId
    ? await sqlite.execute({
        sql: "select lifetime_stats_json, personal_records_json, recent_days_json from wger_summary_blob where character_id = :characterId",
        args: { characterId },
      })
    : { rows: [] };
  const row = result.rows[0] as { lifetime_stats_json: string | null; personal_records_json: string; recent_days_json: string } | undefined;
  if (!row) return Response.json({ lifetimeStats: null, personalRecords: [], recentDays: [] });
  return Response.json({
    lifetimeStats: row.lifetime_stats_json ? JSON.parse(row.lifetime_stats_json) : null,
    personalRecords: JSON.parse(row.personal_records_json),
    recentDays: JSON.parse(row.recent_days_json),
  });
}

async function handlePutWgerSummary(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.characterId || !body?.characterName || !Array.isArray(body.personalRecords) || !Array.isArray(body.recentDays)) {
    return Response.json({ error: "expected { characterId, characterName, lifetimeStats, personalRecords: [...], recentDays: [...] }" }, { status: 400 });
  }

  await sqlite.execute({
    sql: `insert into wger_summary_blob (character_id, character_name, lifetime_stats_json, personal_records_json, recent_days_json, updated_at)
          values (:characterId, :characterName, :lifetimeStatsJson, :personalRecordsJson, :recentDaysJson, :updatedAt)
          on conflict(character_id) do update set
            character_name = excluded.character_name,
            lifetime_stats_json = excluded.lifetime_stats_json,
            personal_records_json = excluded.personal_records_json,
            recent_days_json = excluded.recent_days_json,
            updated_at = excluded.updated_at`,
    args: {
      characterId: body.characterId,
      characterName: body.characterName,
      lifetimeStatsJson: body.lifetimeStats ? JSON.stringify(body.lifetimeStats) : null,
      personalRecordsJson: JSON.stringify(body.personalRecords),
      recentDaysJson: JSON.stringify(body.recentDays),
      updatedAt: new Date().toISOString(),
    },
  });

  return Response.json({ ok: true });
}

/** `characterId` scopes the inbox to whichever character the requesting device authenticated as (see server/broadcast.ts's fetchMessages) — a note left for Kevin only ever shows up here when fetched with `?character=<kevin's id>`, never in Jacqueline's own inbox fetch. A message with no character_id (pre-scoping rows, or anything posted without one) matches nobody's filtered fetch — not retroactively shown to everyone. */
async function handleGetMessages(characterId: string | null): Promise<Response> {
  const result = characterId
    ? await sqlite.execute({ sql: "select * from messages where character_id = :characterId order by id desc limit 200", args: { characterId } })
    : { rows: [] };
  return Response.json(result.rows);
}

async function handlePostMessage(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const author = typeof body?.author === "string" ? body.author.trim() : "";
  const characterId = typeof body?.characterId === "string" ? body.characterId : null;

  if (!text) return Response.json({ error: "message text is required" }, { status: 400 });
  if (text.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: `message too long (max ${MAX_MESSAGE_LENGTH} chars)` }, { status: 400 });
  }
  if (author.length > MAX_AUTHOR_LENGTH) {
    return Response.json({ error: `name too long (max ${MAX_AUTHOR_LENGTH} chars)` }, { status: 400 });
  }

  await sqlite.execute({
    sql: "insert into messages (author, text, character_id, created_at) values (:author, :text, :characterId, :createdAt)",
    args: { author: author || null, text, characterId, createdAt: new Date().toISOString() },
  });

  return Response.json({ ok: true });
}

/** `characterId` scopes the delete the same way handleGetMessages scopes the read — without this, any authorized device could delete ANY character's message just by knowing/guessing its (small, sequential) id, not just messages in its own inbox. A missing/mismatched characterId deletes nothing (0 rows affected) rather than falling back to an unscoped delete. */
async function handleDeleteMessage(id: string, characterId: string | null): Promise<Response> {
  await sqlite.execute({ sql: "delete from messages where id = :id and character_id = :characterId", args: { id: Number(id), characterId } });
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
  const characterId = characterIdFrom(url);

  if (method === "GET" && pathname === "/") {
    return Response.json({ ok: true, service: "House Simulator status API" });
  }

  if (method === "GET" && pathname === "/api/all") {
    return handleGetAll();
  }

  if (method === "GET" && pathname === "/api/characters") {
    return handleGetCharacters();
  }

  if (method === "GET" && pathname === "/api/status") {
    return handleGetStatus(characterId);
  }

  if (method === "PUT" && pathname === "/api/status") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutStatus(req);
  }

  if (method === "GET" && pathname === "/api/goals") {
    return handleGetGoals(characterId);
  }

  if (method === "PUT" && pathname === "/api/goals") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutGoals(req);
  }

  if (method === "GET" && pathname === "/api/stats") {
    return handleGetStats(characterId);
  }

  if (method === "PUT" && pathname === "/api/stats") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutStats(req);
  }

  if (method === "GET" && pathname === "/api/period-stats") {
    return handleGetPeriodStats(characterId);
  }

  if (method === "PUT" && pathname === "/api/period-stats") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutPeriodStats(req);
  }

  if (method === "GET" && pathname === "/api/yesterday") {
    return handleGetYesterday(characterId);
  }

  if (method === "PUT" && pathname === "/api/yesterday") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutYesterday(req);
  }

  if (method === "GET" && pathname === "/api/streaks") {
    return handleGetStreaks(characterId);
  }

  if (method === "PUT" && pathname === "/api/streaks") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutStreaks(req);
  }

  if (method === "GET" && pathname === "/api/workout-today") {
    return handleGetWorkoutToday(characterId);
  }

  if (method === "PUT" && pathname === "/api/workout-today") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutWorkoutToday(req);
  }

  if (method === "GET" && pathname === "/api/wger-summary") {
    return handleGetWgerSummary(characterId);
  }

  if (method === "PUT" && pathname === "/api/wger-summary") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handlePutWgerSummary(req);
  }

  if (method === "GET" && pathname === "/api/messages") {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleGetMessages(characterId);
  }

  if (method === "POST" && pathname === "/api/messages") {
    return handlePostMessage(req);
  }

  const deleteMatch = pathname.match(/^\/api\/messages\/(\d+)$/);
  if (method === "DELETE" && deleteMatch) {
    if (!isAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handleDeleteMessage(deleteMatch[1], characterId);
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
