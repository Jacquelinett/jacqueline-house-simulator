# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run tauri dev      # run the desktop app (Rust shell + Vite dev server)
npm run build           # tsc + vite build -> dist/ (the Tauri app only)
npm run build:viewer    # vite build --config vite.viewer.config.ts -> dist-viewer/ (the public viewer only)
```

There is no test suite yet (deliberate — not yet decided what's worth testing here).

`tsconfig.json` has `noUnusedLocals`/`noUnusedParameters` on — an unused import or variable fails `npm run build` (not just a lint warning), so clean up as you go rather than leaving dead imports for later.

The Tauri app (`npm run build`) and the public viewer (`npm run build:viewer`) are two **separate** Vite builds (`vite.config.ts` vs `vite.viewer.config.ts`) from the same `src/`. Building one does not touch the other's output directory.

## Architecture

### The three things in this repo

1. **Desktop app** (`src/main.ts` entry, `index.html`) — the actual Tauri app. Talks to a local `aw-server` and to the filesystem (goals/todos/settings persisted as JSON under `$APPDATA` via `@tauri-apps/plugin-fs`).
2. **Public viewer** (`src/viewer-main.ts` entry, `viewer.html`) — a static site, deployed to GitHub Pages, with no access to AW or the filesystem. Polls a remote API for whatever it needs to display.
3. **`valtown/houseSimulatorStatus.ts`** — a small HTTP val (pasted by hand into val.town's editor, not deployed from this repo) that the desktop app pushes to and the viewer polls. Pure data relay, no business logic — see "Why val.town is dumb" below.

### Scene rendering: one engine, two interactivity levels

`src/scene/renderer.ts` (`SceneRenderer`) builds the isometric scene — rooms, objects, camera panning, room-dimming focus, "currently doing X" overlay highlighting — with **no interactivity of its own**. It exposes two protected no-op hooks, `attachRoomInteraction`/`attachObjectInteraction`, that subclasses override:

- `src/scene/House.ts` (`House`) — the desktop app's view. Adds click handling, the object context menu, and calls into `src/aw/client.ts` to actually start/stop tracking.
- `src/scene/viewer.ts` (`HouseViewer`) — the public viewer's view. Room clicks and `navigate` actions (staircases) work the same as `House` — it's just looking around. Clicking an `activity` object only shows a floating text label with the object's name; it never calls anything AW-related, since the viewer has no AW access regardless.

Room/object data (`src/scene/rooms.ts`) and tileset variants (`src/scene/tileset.ts`) are shared, unmodified, by both.

### AW activity tracking (`src/aw/client.ts`)

Reuses aw-webui's own manual-stopwatch bucket (`general.stopwatch`, `data: {running, label}`) so tracked time shows up in AW's own UI too, not just this app's.

Hard-won correctness rules, each backed by a real bug this session:

- **Never use `client.heartbeat()` for periodic refresh.** It merges into the last event or inserts a new one based on whether the gap since the last call is under its `pulsetime` — and browsers/webviews throttle `setInterval` in backgrounded windows, which can silently stretch that gap past `pulsetime` and split one continuous session into two events. Every periodic tick instead calls `client.replaceEvent()` by the event's own known id, recomputing `duration` fresh from wall-clock time (`now - startedAt`) — correct regardless of how delayed a tick was, no merge-or-insert ambiguity possible.
- **`replaceEvent`/`insertEvents` both POST to the same `/events` endpoint**; whether it inserts or updates-in-place depends entirely on aw-server recognizing a pre-set `id` in the payload as "replace this." Confirmed empirically against a live server — it genuinely does update in place, but **only when the id is correct and already exists**. IDs are global across the whole aw-server instance, not scoped to one bucket — never use a placeholder/guessed id in a replace call, even in a throwaway test bucket, or you can silently clobber/relocate an unrelated real event elsewhere.
- **Only one House Simulator activity may be `running: true` at a time, enforced against AW directly, not just in-memory state.** The app no longer stops tracking when the window closes (an overnight sleep-tracking session should keep accruing time with the app shut), so a *different* activity being started is the actual moment something earlier needs closing out — and it may not be reflected in memory if the app just restarted. `startActivity()` checks AW's actual latest event, not just the local `current` variable, before beginning anything new.
- **`resumeActivity()` (called on launch) extends the still-running event's duration to real elapsed time, regardless of gap length** — it does not truncate after some timeout, and does not care if the app was closed for 10 seconds or 10 hours. This is deliberate: it's what makes leaving something "running" across an app restart meaningful (e.g. sleep tracking) instead of just a crash-recovery nicety.

### Goals

`src/goals/types.ts` defines `Recurrence` (`once` / `weekly` / `monthly`-by-Nth-or-last-weekday) and `Goal` (activity label + target minutes + recurrence + optional `skipDates`). `src/goals/recurrence.ts`'s `isScheduledOn()` is the one function that decides "does this goal apply today" — it's imported directly (not duplicated) everywhere that needs it, including the viewer build.

AW only measures time per activity **label**, not per goal — so the UI (`src/goals/progress.ts`) groups all of today's scheduled goals by activity label and sums their targets before comparing against tracked time, rather than tracking progress per-goal. Re-adding a goal for the same activity + identical schedule extends the existing one's target instead of creating a duplicate (so "I practiced piano, finished my 1hr goal, then added another 30min" correctly un-finishes it rather than showing two cards).

### Three always-or-on-demand surfaces, split by time range

Status/progress UI is split across three places, deliberately divided by **time range + audience** rather than by data type (goals vs. activity):

- **Jacqueline panel** (`src/goals/panel.ts`, `buildFloatingPanel` title hardcoded to `CURRENT_USER_NAME`) — always visible, not closable, not draggable. Just "who's using the house, what they're doing right now, connection health" — no goal data here anymore.
- **Dashboard panel** (`src/dashboard/panel.ts`) — always visible, not closable, draggable. **Today-only**: today's goal progress + today's activity breakdown.
- **Statistic modal** (`src/dashboard/statisticModal.ts`) — opened on demand from the "Statistic" button. **All-time-only**: most completed/skipped activity, all-time activity pie.

This came from Dashboard and Jacqueline originally overlapping (both showing goal info) and Dashboard itself originally being one tabbed panel mixing today-only and all-time data. If a new "status" need comes up, put it in whichever of these three already matches its time range rather than adding a fourth surface or reintroducing tabs — the overlap is what got fixed here. All-time stats are only computed when the Statistic modal is actually opened (`getActivityStats()` scans a much wider AW date range) — unlike Dashboard's today-only queries, which legitimately re-tick every 30s, there's no reason to keep re-scanning for a modal nobody has open.

### Shared panel chrome (`src/ui/draggablePanel.ts`)

`buildFloatingPanel(title, { closable?, draggable?, className? })` is the one implementation behind both Jacqueline and Dashboard's header/body/drag chrome — both default to `true` for `closable`/`draggable`; Jacqueline overrides both to `false` since it always lives in the same corner and is never meant to be dismissed.

Dragging is done via a dedicated grip-icon button in the header (`.floating-panel-drag-handle`), not the whole header — grabbing the title text to move the panel used to fight with just trying to read it. The grip icon itself is drawn with CSS `box-shadow` (a 2×3 dot grid), not a Unicode glyph — a glyph's availability/rendering varies by platform font, a CSS shape doesn't.

### Shared rendering between the desktop app and the viewer

The viewer and the desktop app need to show the *same* sections (Dashboard's Today's Goals/Today's Activity, Jacqueline's current-activity/sync-status) but get their data from fundamentally different sources — the desktop app queries AW directly, the viewer only has whatever was last polled from val.town plus client-side live-elapsed math. The fix was splitting "compute the data" (stays separate per surface) from "render the data to DOM" (shared):

- `src/goals/todayGroups.ts`'s `groupTodaysGoals()` — the one goal-grouping-by-label implementation. Before this, `goals/progress.ts`, `dashboard/panel.ts`, and `viewer-main.ts` each independently re-derived the same grouping.
- `src/dashboard/render.ts` — `buildDashboardSections()`/`renderGoalList()`/`renderActivityList()`, called by both `dashboard/panel.ts` (fed by `getTodayGoalProgress()`/`getTodayActivityStats()`, local AW queries) and `viewer-main.ts` (fed by polled `/api/status`+`/api/goals` plus `startedAt`-based live elapsed, same trick used elsewhere).
- `src/status/render.ts` — `renderCurrentActivity()`/`renderSyncStatus()` for the Jacqueline panel's content. `renderSyncStatus`'s `showAw` flag is why the viewer never shows an "AW: Connected"/"Disconnected" line at all — it has no AW access full stop, not merely "currently disconnected."

**Gotcha if you add a new shared-rendering class:** `styles.css` and `viewer-styles.css` are two independent files — there's no import/sharing mechanism between the two Vite builds' CSS. The shared `render.ts` functions emit the same class names in both outputs by convention (`goal-row`, `goal-subrow`, `dashboard-row`, `dashboard-list`, etc.), but each stylesheet still needs its own copy of the CSS rule for that class. Add a class in one `render.ts` file and forget the other stylesheet, and it renders unstyled in whichever build you missed.

One function's scope quietly broadened for this: `getTodayMinutesByLabel()` (`src/goals/progress.ts`) used to only cover activities that had a goal attached (its one caller was the goal-progress calc). It now covers every entry in `ACTIVITIES`, because the viewer's Today's Activity list needed full parity with the desktop Dashboard's — not just whatever happened to have a goal.

### Shared persistence (`src/lib/`)

`jsonFileStore.ts` (load/save a JSON file under `$APPDATA`) and `persistedState.ts` (in-memory value + change-listener `Set`, backed by a store) are the two pieces every feature's `state.ts`/`store.ts` is built from (goals, todos, settings). Reuse these for any new local-persisted domain rather than copy-pasting a fourth near-identical pair.

### Broadcasting: why val.town is deliberately dumb

The viewer can never reach the local `aw-server` directly — it's a separate static site, possibly on a different machine. So *something* local has to combine goal targets with tracked time and publish the result; `val.town` only stores and forwards two independently-pushed blobs:

- **Goal definitions** (targets + schedules, not progress) — pushed whenever goals change (`onGoalsChange` → `pushGoals()`), independent of activity changes, so editing a goal reaches the viewer immediately instead of waiting for the next activity switch.
- **Today's tracked minutes per activity label**, *excluding* whatever's currently running — pushed on activity change (`onActivityChange` → `pushStatus()`) and once at startup. Nothing is re-pushed on a timer.

The viewer joins these two itself — computes "is this goal scheduled today," sums targets by label, and adds the *live* elapsed time for whichever label matches the currently-running activity (the same `startedAt`-based client-side math as its "Running for X" clock). This is why val.town never needs to recompute anything when a goal is edited or time passes: both halves are always independently fresh, and the join is cheap and stateless on the client.

**A real backend (with actual computation/joins) was deliberately rejected** for this — see the conversation history around "do we need a second backend" if resurrecting that question; the conclusion was that AW-local-only data makes a smarter backend not actually solve anything a dumb relay doesn't.

**Dead end, don't retry:** serving the actual Pixi-rendered viewer directly from val.town (so val.town alone would be the whole public site, no GitHub Pages needed) was tried and reverted — val.town caps a val's own source at **80,000 characters**, and a bundled Pixi app is several hundred KB even minified. Not a tuning problem; the viewer needs real static hosting (GitHub Pages).

**Schema migration gotcha:** val.town's `ensureSchema()` uses `CREATE TABLE IF NOT EXISTS`, which is a no-op once a table already exists in the live val's database — it does **not** retroactively add new columns. Any future change to an existing table's shape needs an explicit `ALTER TABLE ... ADD COLUMN` (wrapped in a `.catch(() => {})`, since it only fails if the column's already there) alongside updating the `CREATE TABLE` statement for fresh deployments. This bit us once already (a renamed column silently never existed on the live table, so every status push was failing with no visible error — see `pushStatus`'s `res.ok` check below).

**Never trust `fetch()` resolving as "it worked."** `fetch()` only rejects on network-level failures — an HTTP error response (e.g. the 500 from the schema bug above) resolves completely normally. `src/broadcast/client.ts` explicitly checks `res.ok` and tracks last-success/last-error, surfaced as the "VT: Synced ..." half of the Jacqueline panel's status line (the one place in the app that's always visible without opening devtools) — and, symmetrically, as the viewer's own "VT: Synced ..." line for its last successful *poll* rather than push (see "Shared rendering" below).

### GitHub Pages deployment (`.github/workflows/deploy-viewer.yml`)

Builds and deploys only `dist-viewer/` on every push to `main` — the desktop app's own source is never published. Two things that would silently break if "fixed" without understanding why:

- `vite.viewer.config.ts` sets `base: "/jacqueline-house-simulator/"` — GitHub Pages serves a project repo from that subpath, not domain root. Every texture path in `rooms.ts` is a root-relative string (`/objects/piano_base.png`) baked in long before Pages was a consideration; `src/scene/renderer.ts`'s `assetUrl()` helper routes every one of them through `import.meta.env.BASE_URL` so they resolve under the subpath. (`BASE_URL` is `/` for the Tauri app's own build — this is a no-op there.)
- `npm run build:viewer` renames the build output from `viewer.html` to `index.html` as a second step. Can't just name the *source* file `index.html` — the Tauri app's own entry already owns that name at the repo root — but Pages needs `index.html` specifically to serve the bare directory URL (`/jacqueline-house-simulator/`) instead of 404ing while `/jacqueline-house-simulator/viewer.html` works fine.
