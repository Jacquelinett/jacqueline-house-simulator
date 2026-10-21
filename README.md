# House Simulator

A gamified desktop frontend for [ActivityWatch](https://docs.activitywatch.net/en/latest/): an isometric house where clicking an object (piano, PC, DDR cabinet, ...) starts/stops time tracking for that activity, using AW's own `general.stopwatch` bucket under the hood. Built with Tauri + Vite + TypeScript + Pixi.js.

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

Room and object layout lives in `src/scene/rooms.ts` — plain data, no rendering logic. Art assets go in:

- `public/rooms/<room-id>.png` — room background, referenced via `background: "/rooms/<room-id>.png"`
- `public/objects/<object-id>.png` — object sprite layers, referenced via `texture: "/objects/<object-id>.png"` inside `sprite`/`layersBelow`/`layersAbove`

Objects without an `actions` entry are pure decoration (no click handling). With one action, clicking toggles it directly; with two or more, clicking opens a small menu to pick which one.
