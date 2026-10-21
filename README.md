# House Simulator

A gamified desktop frontend for [ActivityWatch](https://docs.activitywatch.net/en/latest/): an isometric house where clicking an object (piano, PC, DDR cabinet, ...) starts/stops time tracking for that activity, using AW's own `general.stopwatch` bucket under the hood. Built with Tauri + Vite + TypeScript + Pixi.js.

On top of tracking, it has daily/recurring **goals** (e.g. "practice piano 30 min, every Mon/Wed"), a simple **todo list**, a **pomodoro-style timer** (deliberately not tracked by AW), and an optional **public status broadcast**: a read-only web page showing whatever's currently running + today's goal progress, that friends/family can view and leave you a note on.

## Prerequisites

- [Node.js](https://nodejs.org/) and npm
- [Rust](https://www.rust-lang.org/tools/install) (via `rustup`) — required by Tauri
- [ActivityWatch](https://activitywatch.net/) installed and running (`aw-server` reachable at `http://127.0.0.1:5600`)

## One-time setup: allow this app's origin through AW's CORS

By default `aw-server` doesn't send CORS headers, so a browser/webview-based client other than its own bundled `aw-webui` is blocked from calling its API. Add this app's dev origin to `aw-server`'s config:

**macOS:** `~/Library/Application Support/activitywatch/aw-server/aw-server.toml`

```toml
[server]
cors_origins = "http://localhost:1420,http://127.0.0.1:1420"
```

(`1420` is this project's Vite dev port, set in `src-tauri/tauri.conf.json`'s `build.devUrl`.) Then restart ActivityWatch (quit and relaunch the app, or restart `aw-qt`) so it picks up the change.

## Running

```bash
npm install
npm run tauri dev
```

This compiles the Rust shell (slow the first time, cached after) and opens the app window. Vite hot-reloads on changes to `src/`; Rust changes under `src-tauri/` require a rebuild (automatic on save while `tauri dev` is running).

## Editing rooms/objects

Room and object layout lives in `src/scene/rooms.ts` — plain data, no rendering logic (that's `src/scene/renderer.ts`). Floors/walls are a real tilemap built from named variants in `src/scene/tileset.ts` (`public/tileset.png`), not a per-room background image. Object sprites are individual files in `public/objects/<object-id>.png`, referenced via `texture` inside an object's `below`/`overlay`/`above` layers.

Objects without an `actions` entry are pure decoration (no click handling). With one action, clicking toggles it directly; with two or more, clicking opens a small menu to pick which one. An action is either `{ kind: "activity", label }` (starts/stops AW tracking for that label) or `{ kind: "navigate", roomId }` (e.g. a staircase — just jumps the camera, no tracking).

## Public status broadcast (optional)

Lets you share a link that shows your current activity + goal progress, read-only, with a way for people to leave you a message. Two pieces, both optional and independent of the desktop app working normally without them:

1. **`valtown/houseSimulatorStatus.ts`** — paste into a [val.town](https://www.val.town/) HTTP val. It's a pure data API (no rendering) — see the file's own header comment for its endpoints and the one-time setup (an `HOUSE_SIM_SECRET` environment variable in the val's sidebar). Put the val's URL and that same secret into the app's Settings.
2. **The viewer** (`viewer.html` / `src/viewer-main.ts`) — the actual page people see, built separately via `npm run build:viewer` (outputs `dist-viewer/`) and deployed to GitHub Pages automatically by `.github/workflows/deploy-viewer.yml` on every push to `main`. Repo Settings → Pages → Source must be set to "GitHub Actions" once, by hand.

See `CLAUDE.md` for how these two pieces talk to each other and why it's split this way.
