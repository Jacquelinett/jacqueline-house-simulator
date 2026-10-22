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
import { setupRpc } from "./rpc";
import { getServerConfig } from "./serverConfig";
import { pushGoals, pushPeriodStats, pushStats, pushStatus, pushTodayStreaks, pushYesterdayStats } from "./broadcast";
import { serveStatic } from "./staticServer";
import { listCharacters } from "./characters";
import { seedMockWorkoutsIfEmpty } from "./workouts";
import { localDateString } from "../src/goals/recurrence";
import { seedActivitiesIfEmpty } from "./activities";
import { seedObjectTypesIfEmpty } from "./objectTypes";
import { seedRoomsIfEmpty } from "./rooms";
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

async function main() {
  migrate();
  seedActivitiesIfEmpty();
  seedObjectTypesIfEmpty();
  seedRoomsIfEmpty();

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

  const jacqueline = characters.find((c) => c.name === "Jacqueline");

  // Mock wger data (see server/workouts.ts's own comment) — only for
  // Jacqueline, and only if today has nothing yet, so this doesn't
  // overwrite anything on every restart.
  if (jacqueline) seedMockWorkoutsIfEmpty(jacqueline.id, localDateString(new Date()));

  onGoalsChange(() => {
    // val.town/the public viewer only ever show Jacqueline's goals for now.
    if (jacqueline) pushGoals(jacqueline.id).catch((err) => console.error("[server] pushGoals after change failed", err));
  });

  // Never blocks startup — settlement is gamification bookkeeping, not
  // core function. Runs once now, then hourly (see SETTLE_INTERVAL_MS).
  // Settles every character's goals, not just Jacqueline's.
  settleGoalHistory().catch((err) => console.error("[server] failed to settle goal history", err));
  setInterval(() => {
    settleGoalHistory().catch((err) => console.error("[server] failed to settle goal history", err));
  }, SETTLE_INTERVAL_MS);

  if (jacqueline) {
    // Pushed once on startup so a viewer isn't stuck showing stale data
    // from last session; pushStatus also re-fires on every activity
    // change (see rpc.ts), pushGoals on every goal change (above).
    pushStatus(jacqueline.id).catch((err) => console.error("[server] initial pushStatus failed", err));
    pushGoals(jacqueline.id).catch((err) => console.error("[server] initial pushGoals failed", err));

    // Stats scan much more AW history (or, for streaks, more of the
    // history log) than pushStatus's today-only query, so they get their
    // own slow timer — see CLAUDE.md's "Broadcasting" section for why
    // none of these get their own separate cadence even though some are
    // static between boundary crossings.
    const runStatsPushes = () => {
      pushStats(jacqueline.id).catch((err) => console.error("[server] pushStats failed", err));
      pushPeriodStats(jacqueline.id).catch((err) => console.error("[server] pushPeriodStats failed", err));
      pushYesterdayStats(jacqueline.id).catch((err) => console.error("[server] pushYesterdayStats failed", err));
      pushTodayStreaks(jacqueline.id).catch((err) => console.error("[server] pushTodayStreaks failed", err));
    };
    runStatsPushes();
    setInterval(runStatsPushes, STATS_PUSH_INTERVAL_MS);
  }

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
