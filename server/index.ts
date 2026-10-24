import http from "node:http";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { migrate } from "./db";
import { getAllGoals, initGoalsState, onGoalsChange } from "./goals";
import { initTodosState } from "./todos";
import { settleGoalHistory } from "./goalHistory";
import { ensureStopwatchBucket, resumeActivity } from "../src/aw/client";
import { setupRpc, stopOrphanedActivities } from "./rpc";
import { evaluateLightSchedules } from "./lightSchedule";
import { getServerConfig } from "./serverConfig";
import {
  pushGoals,
  pushHouseLayout,
  pushPeriodStats,
  pushStats,
  pushStatus,
  pushTodayStreaks,
  pushWorkoutToday,
  pushWgerSummary,
  pushYesterdayStats,
} from "./broadcast";
import { serveStatic } from "./staticServer";
import { listCharacters } from "./characters";
import { seedActivitiesIfEmpty } from "./activities";
import { seedObjectTypesIfEmpty } from "./objectTypes";
import { seedRoomsIfEmpty } from "./rooms";
import { seedFloorsIfEmpty } from "./floors";
import { handleAdminApi } from "./adminApi";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The Tauri app's own `npm run build` output — same bundle its webview
// loads from disk, served over HTTP here for a plain browser on the LAN.
// See CLAUDE.md's "One build, two delivery mechanisms".
const DIST_DIR = resolve(__dirname, "../dist");
// The admin tool's own build — a separate Vite entry, served under /admin/
// rather than at the root (see server/staticServer.ts's urlPathOverride).
const ADMIN_DIST_DIR = resolve(__dirname, "../dist-admin");

const PORT = Number(process.env.PORT ?? 4000);
const STATS_PUSH_INTERVAL_MS = 60 * 60 * 1000;
// Settlement only needs to run once a day (it never backfills past
// yesterday), but checking hourly is cheap and means a server restart
// mid-day still catches up promptly instead of waiting for a fixed time.
const SETTLE_INTERVAL_MS = 60 * 60 * 1000;
// Much tighter than the hourly stats/settlement timers above -- a
// scheduled light needs to catch its own on/off boundary within about a
// minute of it actually passing, not sometime within the next hour.
// evaluateLightSchedules() itself is cheap (self-skips any object whose
// window hasn't changed, see its own comment), so a short interval here
// costs nothing when nothing's actually crossing a boundary.
const LIGHT_SCHEDULE_INTERVAL_MS = 60 * 1000;

async function main() {
  migrate();
  seedActivitiesIfEmpty();
  seedObjectTypesIfEmpty();
  seedRoomsIfEmpty();
  seedFloorsIfEmpty();

  const characters = listCharacters();
  console.log(`[server] characters: ${characters.map((c) => c.name).join(", ")}`);

  if (!getServerConfig().broadcastUrl) {
    console.warn("[server] no broadcast_url set in server_config — val.town pushes will silently no-op.");
  }
  if (!getServerConfig().adminSecret) {
    console.warn(
      "[server] no admin_secret set in server_config — the admin tool is unreachable. " +
        "Set one via: UPDATE server_config SET admin_secret = '...' WHERE id = 1;",
    );
  }
  if (!existsSync(DIST_DIR)) {
    console.warn(`[server] ${DIST_DIR} does not exist — run \`npm run build\` first, or the frontend won't be servable over HTTP.`);
  }
  if (!existsSync(ADMIN_DIST_DIR)) {
    console.warn(`[server] ${ADMIN_DIST_DIR} does not exist — run \`npm run build:admin\` first, or the admin tool won't be servable.`);
  }

  await initGoalsState();
  await initTodosState();

  // Every character gets their own AW bucket, set up and resumed
  // independently — see src/aw/client.ts's per-bucket state.
  for (const character of characters) {
    await ensureStopwatchBucket(character.awBucketId);
    // Picks back up whatever AW still has marked running from a previous
    // session (e.g. the server restarted mid-activity) — same reasoning
    // main.ts's own resumeActivity() call had, just with no House/UI to
    // hand the result to here; the next status broadcast/push already
    // reflects it since getCurrentActivity() is now correct.
    await resumeActivity(character.awBucketId).catch((err) =>
      console.error(`[server] failed to resume previous activity for ${character.name}`, err),
    );
  }

  // A resumed session could be tracking a room/object that was deleted
  // (or reconfigured) while the server was down — default back to idle
  // rather than silently keep accruing time for something that no longer
  // exists anywhere in the house. See rpc.ts's own comment.
  await stopOrphanedActivities().catch((err) => console.error("[server] stopOrphanedActivities at startup failed", err));

  if (!getServerConfig().wgerBaseUrl) {
    console.warn("[server] no wger_base_url set in server_config — getWorkoutsForDate() will return no data for every character until it's configured.");
  }

  // Re-queried fresh at each use (not captured once here) so an admin
  // toggling a character's "Publish to viewer" checkbox takes effect at
  // the next natural push point (next activity change, next hourly tick)
  // instead of needing a full server restart.
  function getPublishedCharacters() {
    return listCharacters().filter((c) => c.publishToViewer);
  }

  onGoalsChange(() => {
    // Doesn't know which character's goals changed (one shared in-memory
    // store underneath — see server/goals.ts's own comment), so push
    // every published character's, same reasoning the WS broadcast
    // equivalent (broadcastEachClient in rpc.ts) already uses.
    for (const character of getPublishedCharacters()) {
      pushGoals(character.id).catch((err) => console.error(`[server] pushGoals after change failed for ${character.name}`, err));
    }
  });

  // Never blocks startup — settlement is gamification bookkeeping, not
  // core function. Runs once now, then hourly (see SETTLE_INTERVAL_MS).
  // Settles every character's goals, not just Jacqueline's.
  settleGoalHistory().catch((err) => console.error("[server] failed to settle goal history", err));
  setInterval(() => {
    settleGoalHistory().catch((err) => console.error("[server] failed to settle goal history", err));
  }, SETTLE_INTERVAL_MS);

  // Global data (not per-character, unlike everything above) — pushed
  // once on startup so a viewer isn't stuck showing whatever was baked
  // into its own bundle at the last `npm run build:viewer`. No recurring
  // timer and no per-admin-edit push: the admin tool's own "Sync" button
  // (see adminApi.ts's /api/admin/sync-house-layout) is the only other
  // time this goes out — admin edits are infrequent and usually come in
  // a burst, so an explicit sync once the admin's actually done beats
  // either polling or pushing after every single field change.
  pushHouseLayout().catch((err) => console.error("[server] initial pushHouseLayout failed", err));

  for (const character of getPublishedCharacters()) {
    // Pushed once on startup so a viewer isn't stuck showing stale data
    // from last session; pushStatus also re-fires on every activity
    // change (see rpc.ts), pushGoals on every goal change (above).
    pushStatus(character.id).catch((err) => console.error(`[server] initial pushStatus failed for ${character.name}`, err));
    pushGoals(character.id).catch((err) => console.error(`[server] initial pushGoals failed for ${character.name}`, err));
    pushWorkoutToday(character.id).catch((err) => console.error(`[server] initial pushWorkoutToday failed for ${character.name}`, err));
    pushWgerSummary(character.id).catch((err) => console.error(`[server] initial pushWgerSummary failed for ${character.name}`, err));
  }

  // Stats scan much more AW history (or, for streaks, more of the history
  // log) than pushStatus's today-only query, so they get their own slow
  // timer — see CLAUDE.md's "Broadcasting" section for why none of these
  // get their own separate cadence even though some are static between
  // boundary crossings. One shared timer for every published character,
  // re-queried fresh each tick (see getPublishedCharacters's own comment).
  // pushWorkoutToday rides along on this same timer too: like pushStatus,
  // nothing in this app ever learns synchronously that a new set got
  // logged in wger (that happens on her phone, outside this app entirely)
  // — only a poll can find out — but unlike pushYesterdayStats/
  // pushTodayStreaks, today's workout genuinely can still change through
  // the day, so it always re-fetches on every tick rather than
  // self-skipping once "today" has already been pushed once. pushWgerSummary
  // (Lifetime Stats + Personal Records) rides along too — lifetime totals
  // and PRs are about as static as pushStats's own activity totals, same
  // "no separate cadence" reasoning.
  const runStatsPushes = () => {
    for (const character of getPublishedCharacters()) {
      pushStats(character.id).catch((err) => console.error(`[server] pushStats failed for ${character.name}`, err));
      pushPeriodStats(character.id).catch((err) => console.error(`[server] pushPeriodStats failed for ${character.name}`, err));
      pushYesterdayStats(character.id).catch((err) => console.error(`[server] pushYesterdayStats failed for ${character.name}`, err));
      pushTodayStreaks(character.id).catch((err) => console.error(`[server] pushTodayStreaks failed for ${character.name}`, err));
      pushWorkoutToday(character.id).catch((err) => console.error(`[server] pushWorkoutToday failed for ${character.name}`, err));
      pushWgerSummary(character.id).catch((err) => console.error(`[server] pushWgerSummary failed for ${character.name}`, err));
    }
  };
  runStatsPushes();
  setInterval(runStatsPushes, STATS_PUSH_INTERVAL_MS);

  // Runs once immediately too, same reasoning as every other timer here
  // (startup should reflect reality right away, not wait a full interval)
  // -- see evaluateLightSchedules's own comment on why this also brings
  // every scheduled light's state in line with its correct window on a
  // restart, not just on an ongoing boundary crossing.
  evaluateLightSchedules();
  setInterval(evaluateLightSchedules, LIGHT_SCHEDULE_INTERVAL_MS);

  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, goalsCount: getAllGoals().length }));
      return;
    }
    if (await handleAdminApi(req, res)) return;
    if (req.url === "/admin" || req.url?.startsWith("/admin/")) {
      const strippedPath = req.url.replace(/^\/admin/, "") || "/";
      if (serveStatic(ADMIN_DIST_DIR, req, res, strippedPath)) return;
    }
    if (serveStatic(DIST_DIR, req, res)) return;
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server });
  setupRpc(wss);

  server.listen(PORT, () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[server] fatal error during startup", err);
  process.exit(1);
});
