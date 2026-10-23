# House Simulator

A gamified frontend for [ActivityWatch](https://docs.activitywatch.net/en/latest/): an isometric house where clicking an object (piano, PC, DDR cabinet, ...) starts time tracking for that activity, using AW's own `general.stopwatch` bucket under the hood. Built with Tauri + Vite + TypeScript + Pixi.js, backed by an always-on Node server.

On top of tracking, it has daily/recurring **goals** (e.g. "practice piano 30 min, every Mon/Wed") with **streaks**, a simple **todo list**, real **wger** workout data for anyone with a linked account, support for **multiple people** tracking independently in the same house, and an optional **public viewer**: a read-only web page showing whatever's currently running + goal/activity stats, that friends/family can look at and leave a note on.

See `CLAUDE.md` for the full architecture writeup (this file is just setup/running). The short version: a Node server (`server/`) is the only thing that talks to AW, SQLite, and val.town — the Tauri desktop app, the public viewer, and the admin tool are all separate frontends that only ever talk to that server, never to AW directly.

## Prerequisites

- [Node.js](https://nodejs.org/) and npm
- [Rust](https://www.rust-lang.org/tools/install) (via `rustup`) — required by Tauri, only for the desktop app
- [ActivityWatch](https://activitywatch.net/) installed and running (`aw-server` reachable at `http://127.0.0.1:5600`) — the Node server is the only thing that needs this; no CORS setup is needed anymore, since the Node server talks to it as a plain server-to-server HTTP client, not from a browser

## Running (local dev)

Two processes, in separate terminals:

```bash
npm install
npm run server      # the Node server — SQLite/AW/val.town owner, required for anything to work
npm run tauri dev    # the desktop app — opens a window, connects to the server above over WebSocket
```

The desktop app does nothing on its own without `npm run server` already running — it's a thin WebSocket client (`src/client/remoteState.ts`). First launch asks for a server address (`ws://localhost:4000` for the same-machine dev case) and a character secret — see "Characters" below.

`npm run tauri dev` compiles the Rust shell (slow the first time, cached after) and opens the app window; Vite hot-reloads on changes to `src/`, Rust changes under `src-tauri/` need a rebuild (automatic on save while `tauri dev` is running). `npm run server` runs via `tsx --watch`, so server-side changes under `server/` also hot-reload.

## Characters (multiple people, one house)

Every goal/todo/activity-tracking is scoped to a **character**, not hardcoded to one person — see CLAUDE.md's "Characters" section. A fresh install seeds one character named "Jacqueline" automatically. To add more people (or to find an existing character's connection secret), use the admin tool (see below) — its Characters tab shows each character's own secret, which is what the desktop app's connection form asks for.

## Admin tool

A separate static site for managing characters/activities/object types/rooms, served by the Node server at `/admin/` (e.g. `http://localhost:4000/admin/` in local dev). Build it with `npm run build:admin` (outputs `dist-admin/`, which the Node server serves directly — no separate dev server for it). Gated by `server_config.admin_secret`, a hand-edited SQLite row — the server logs a warning on startup if it's unset:

```bash
# one-time, against the Node server's own SQLite file (server/data/houseSimulator.db by default)
sqlite3 server/data/houseSimulator.db "UPDATE server_config SET admin_secret = 'pick-something-long-and-random' WHERE id = 1;"
```

## Editing rooms/objects

Rooms, objects, activities, and object types are no longer static compile-time data — they live in SQLite and are edited through the admin tool's Rooms/Activities/Object Types tabs (see CLAUDE.md's "Rooms, floors, and connections" and "Admin tool" sections). `src/scene/rooms.ts`'s `STATIC_ROOM_SPECS`/`STATIC_ACTIVITIES`/`STATIC_OBJECT_TYPES` are one-time seed data for a fresh install only, not something you hand-edit to change the live layout.

An object's `actions` entry is either `{ kind: "activity", activityId }` (starts AW tracking for that activity) or `{ kind: "goTo", roomId }` (e.g. a staircase — jumps the camera, no tracking) — assigned per-object through the admin tool's room editor, not hand-written JSON.

## wger integration (optional)

If you have a self-hosted [wger](https://wger.de) instance, House Simulator can show real logged workouts — today's sets, lifetime stats, personal records, and a recent-sessions log — per character. Set `server_config.wger_base_url` (one shared instance for the whole house) and then each character's own `wger_api_token` through the admin tool's Characters tab. See CLAUDE.md's "wger integration" section for the full picture, including why each is configured separately.

## Public viewer (optional)

Lets you share a link that shows whatever's currently running + goal/activity stats, read-only, with a way for people to leave a note. Three pieces, all optional and independent of the desktop app/Node server working normally without them:

1. **`valtown/houseSimulatorStatus.ts`** — paste into a [val.town](https://www.val.town/) HTTP val. It's a pure data API (no rendering) — see the file's own header comment for its endpoints and the one-time setup (an `HOUSE_SIM_SECRET` environment variable in the val's sidebar). Put the val's URL and that same secret into `server_config` on the Node server (`broadcast_url`/`broadcast_secret` — hand-edited SQLite rows, same pattern as `admin_secret` above; NOT the app's own Settings, which only holds per-device display options now).
2. **The viewer** (`viewer.html` / `src/viewer-main.ts`) — the actual page people see, built separately via `npm run build:viewer` (outputs `dist-viewer/`) and deployed to GitHub Pages automatically by `.github/workflows/deploy-viewer.yml` on every push to `main`. Repo Settings → Pages → Source must be set to "GitHub Actions" once, by hand.
3. **The admin tool's "Sync to viewer" button** — the viewer has no live connection to the Node server, so an admin-tool edit to rooms/activities/object types only reaches it once this is clicked (or the Node server restarts). See CLAUDE.md's "Broadcasting" section.

See `CLAUDE.md` for how these pieces talk to each other and why it's split this way.

## Running on a home server (production)

See `DOCKER.md` for a one-command `docker compose up -d --build` stack (the Node server + a headless `aw-server`) meant to run 24/7. The desktop app itself still runs as a normal `npm run tauri dev`/build on whatever machine someone sits in front of — Docker only packages the always-on backend half.
