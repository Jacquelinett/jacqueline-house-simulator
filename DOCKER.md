# Running the stack on a home server via Docker

This packages the whole stack — Node server, headless AW, and wger — as
one `docker compose up`, per `CLAUDE.md`'s "The Node server"/"AW activity
tracking"/"wger integration" sections:

- **`house-simulator-server`** — this repo's Node server (`server/index.ts`),
  built from the root `Dockerfile`. Owns SQLite, AW access, and val.town
  pushing; also serves the desktop app's `dist/` build and the admin tool's
  `dist-admin/` build over plain HTTP (see CLAUDE.md's "One build, two
  delivery mechanisms").
- **`aw-server`** — a headless build of ActivityWatch's actual data server.
  `aw-qt` (the tray icon app most people associate with "ActivityWatch") is
  just a launcher/watcher-manager around it; `aw-server` itself is a plain
  Rust binary with no GUI dependency, so it runs standalone fine. Rather
  than write a Dockerfile from scratch, this uses an existing community
  image that already does exactly what's needed —
  [GraphicHealer/aw-server-docker](https://github.com/GraphicHealer/aw-server-docker)
  (confirmed via its own Dockerfile: `CMD aw-server --host 0.0.0.0
  --cors-origins "*"`, `EXPOSE 5600`, `VOLUME /config`).
- **wger** — pulled in via the `wger/` **git submodule**
  ([wger-project/docker](https://github.com/wger-project/docker)), not
  vendored/copied — `docker-compose.yml`'s `include:` directive merges its
  own `web`/`celery_worker`/`celery_beat`/`nginx`/`db`(postgres)/
  `cache`(redis)/`powersync` services into this project directly, the same
  "reuse, don't duplicate" reasoning CLAUDE.md's guiding principle states
  for this repo's own code, applied to an external stack instead. Using a
  submodule (rather than copying wger's compose files into this repo)
  means `git submodule update --remote` can pick up wger's own upstream
  changes later without us hand-maintaining a second copy of their
  multi-file compose structure.

## First-time setup on a fresh machine

1. **Clone with the submodule**: `git clone --recurse-submodules <this repo's URL>`,
   or if already cloned, `git submodule update --init`. Without this, the
   `wger/` directory is empty and `docker compose` fails fast with a clear
   "no such file" on `include: - path: ./wger/docker-compose.yml`.
2. Install Docker (Docker Desktop, or plain Docker Engine + the compose
   plugin on Linux).
3. **Edit wger's own secrets** in `wger/config/prod.env` before a real
   deployment — that file is committed *upstream in wger's own repo* with
   their quickstart's placeholder values (`SECRET_KEY`, `POSTGRES_PASSWORD`,
   `CELERY_FLOWER_PASSWORD`, ...), not anything unique to this install.
   This repo never copies those values anywhere else, so there's nothing
   of ours to keep in sync when you change them — see that file's own
   comments for which ones matter most (`SECRET_KEY`, `POSTGRES_PASSWORD`
   at minimum).
4. From the repo root: `docker compose up -d --build`. This builds the
   Node server image, pulls the aw-server image, and brings up wger's
   entire stack (postgres/redis/celery/nginx/web/powersync) alongside it —
   expect this to take a while the first time (wger's `web` image alone is
   substantial, and its startup bootstraps a fresh database).
5. Check everything came up: `docker compose ps` (every service should
   show `Up`/`healthy`), then:
   - `curl http://localhost:4000/health` → `{"ok":true,...}` (House Simulator)
   - `curl http://localhost/api/v2/version/` → wger's own version endpoint
     (via its `nginx` on host port 80)
6. **Set the admin secret** (needed to reach `/admin/` at all — the server
   logs a warning on startup if this is unset):
   ```bash
   docker compose exec house-simulator-server \
     node -e "require('better-sqlite3')('/app/server/data/houseSimulator.db').prepare(\"UPDATE server_config SET admin_secret = 'pick-something-long-and-random' WHERE id = 1\").run()"
   ```
   (`server_config` is a hand-edited SQLite row by design — see CLAUDE.md's
   "Settings are split in two" — there's deliberately no env var for this,
   same as a non-Docker install.) Restart the container afterward
   (`docker compose restart house-simulator-server`) so the warning clears
   and the admin API picks it up — it's read fresh per-request by
   `getServerConfig()`, so this step is actually optional, but a restart
   confirms it took.
7. **Set val.town broadcast credentials**, if you want the public viewer to
   work — same `UPDATE server_config SET broadcast_url = '...',
   broadcast_secret = '...' WHERE id = 1` pattern, once you have a
   val.town HTTP val running (see `valtown/houseSimulatorStatus.ts` and the
   main `README.md`'s "Public status broadcast" section — unrelated to
   Docker, still a one-time manual paste-into-val.town step either way).
8. **Link each character to their own wger account** — same
   `UPDATE server_config SET wger_base_url = 'http://web:8000' WHERE id = 1`
   (note: `http://web:8000`, wger's own service name on the shared Compose
   network, NOT `http://localhost:80` the way a same-machine non-Docker
   install would use) plus, per character, setting their own
   `wger_api_token` via the admin tool's Characters tab — see CLAUDE.md's
   "wger integration" section for the full picture. Create the wger
   account itself (and generate its API token) through wger's own web UI
   first: `http://<home-server-ip>` → sign up/log in → Preferences > API
   key > Generate new API key.
9. Point every device (the Tauri desktop app via `npm run tauri dev`/build,
   or a plain browser) at `http://<home-server-ip>:4000`. The admin tool is
   at `http://<home-server-ip>:4000/admin/`; wger's own web UI is at
   `http://<home-server-ip>` (port 80, via its `nginx`).

## ⚠️ Known upstream issue: a truly fresh wger database may fail to bootstrap

**Confirmed live** while building this: bringing up wger's `web` service
against a brand-new, empty Postgres database (exactly what step 4 above
does on a genuinely fresh install) can fail during its own first-boot
fixture loading, with:

```
psycopg.errors.ForeignKeyViolation: insert or update on table "exercises_translation"
violates foreign key constraint "exercises_translatio_exercise_id_d6c44911_fk_exercises"
DETAIL:  Key (exercise_id)=(659) is not present in table "exercises_exercise".
Bootstrapping the application failed, not starting the server
```

This is **wger's own bundled fixture data** (`docker.io/wger/server:latest`,
confirmed as the exact same image digest Jacqueline's existing non-Docker
wger install already runs successfully) referencing an exercise id that
isn't present in that same image's own exercise fixture — a genuine
upstream data-integrity bug in whatever is currently tagged `latest`, not
something this repo's packaging caused (`aw-server`/`house-simulator-server`
both started and became reachable normally in the same test run; only
wger's own `web` container's bootstrap step failed). It only shows up on a
**genuinely fresh** database — an existing wger install that already
bootstrapped successfully before this bug was introduced upstream is
unaffected, since it never re-runs fixture loading against data that's
already there.

**Workarounds, in order of preference:**
1. Check [wger's GitHub issues](https://github.com/wger-project/wger/issues)
   for this exact error — if already reported/fixed, pull a newer `web`
   image tag once one exists.
2. Pin an older `docker.io/wger/server` tag in `wger/docker-compose.yml`
   that predates whichever fixture change introduced this (bisecting tags
   is manual; not attempted here since a fix may already be upstream by
   the time you read this).
3. **Migrate the existing working database instead of bootstrapping
   fresh** (see "Migrating data to a new install" below) — since an
   already-bootstrapped database never re-runs fixture loading, restoring
   a `pg_dump` from the current working install sidesteps this bug
   entirely. This is also the right move if you specifically want to
   carry over wger's exercise library/settings while still starting with
   a clean *workout log* — restore the dump, then truncate just
   `workoutlog`/`workoutsession` (and whatever else is personal-history
   rather than system data) rather than starting from an empty database.

## What you need to edit before (or right after) first run

- **Ports** — `docker-compose.yml`'s `ports:` entries are `"<host>:<container>"`;
  change the host side (left of the colon) on any service if `4000`,
  `5600`, or wger's `80` (set in `wger/docker-compose.yml`) collides with
  something already running on your home server. `4000` and `80` are the
  two ports that matter for actual use (House Simulator and wger's own web
  UI respectively); `5600` (aw-server's own web UI) is exposed only for
  convenience/debugging and can be removed from `ports:` entirely if you
  don't want AW's UI reachable from the LAN.
- **`platform: linux/amd64`** on the `aw-server` service — only needed on an
  arm64 host (Apple Silicon, Raspberry Pi, ...); the community image has no
  arm64 manifest (confirmed via `docker manifest inspect`). Delete that
  line if your home server is a plain x86_64 box, which is its native
  platform anyway. See that line's own comment in `docker-compose.yml` for
  the from-source fallback if emulation on an ARM host is ever a problem.
- **wger's own secrets** — `wger/config/prod.env`, see step 3 above.
- **House Simulator's secrets** (`admin_secret`, `broadcast_url`/
  `broadcast_secret`, each character's `wger_api_token`) — not env vars,
  see steps 6/7/8 above. There's no `lan_secret` step needed anymore;
  WebSocket auth is per-character (`characters.secret`, see CLAUDE.md's
  "Characters" section), seeded automatically for the default "Jacqueline"
  character on first startup.
- **Volumes** — `house-simulator-data` (House Simulator's own SQLite),
  `aw-server-data` (AW's own buckets/events/settings), and wger's own
  `postgres-data`/`media`/`static`/`celery-beat`/`redis-data` (defined in
  `wger/docker-compose.yml`, merged in by `include:`) are all named
  volumes, so `docker compose down` (without `-v`) keeps everything across
  a restart/rebuild.

## Deploying an update

`house-simulator-server` is the one service actually built from this
repo's own source (`build: context: . / dockerfile: Dockerfile` in
`docker-compose.yml`) — there's no pre-built image for it sitting in a
registry anywhere, so getting new code onto the home server means
rebuilding that image from a fresh checkout. `aw-server` and wger's own
services are all `image:` references instead (pulled pre-built, e.g.
`ghcr.io/graphichealer/aw-server-docker`, `docker.io/wger/server`) — they
never need rebuilding for a House Simulator code change, only an explicit
`docker compose pull` if you want *their* upstream's latest.

Run on the home server itself (not a dev machine — it needs to be in the
actual deployed checkout):
```bash
./scripts/deploy.sh
```
which is just:
```bash
git pull
git submodule update --init   # or --remote wger, to also move wger's own
                               # submodule pointer forward — see the
                               # script's own --update-wger flag for that;
                               # plain --init only re-checks-out whatever
                               # commit THIS repo currently points wger/ at
docker compose up -d --build
```

A few things worth knowing about what that last command actually does:
- **Docker's build cache keeps most rebuilds fast.** The `Dockerfile` runs
  `npm ci` before copying in source — if `package.json`/`package-lock.json`
  haven't changed, that whole layer is reused from cache, so a routine code
  update is really just "recompile + re-run the three Vite builds," not a
  full dependency reinstall. A new/changed dependency invalidates that
  layer and takes longer, same as any other Docker build.
- **Only what actually changed gets touched.** Compose only rebuilds
  services with a `build:` block that changed, and only *recreates*
  containers whose image or config actually differs from what's running —
  `aw-server`/wger's containers won't even restart from a House Simulator
  code deploy, since nothing about their `image:` references changed.
- **No data is anywhere near this.** `house-simulator-data`/`aw-server-data`/
  wger's own volumes are all separate from the image entirely — rebuilding
  never touches them, same as any other `docker compose up --build`.

## Migrating data to a new install

Two independent databases, two independent procedures — there's no single
combined export/import, and that's deliberate (you may want to bring over
one but not the other, e.g. a clean wger start per the note above).

**House Simulator** (`scripts/export-house-data.sh`): produces one
consistent SQLite snapshot via `sqlite3`'s own online-backup command
(safe to run against a live server — it's not a plain file copy, so it
can't catch a half-written page or miss whatever's only in the WAL file
so far). Run it against the OLD install's database (works the same
whether that's a bare `npm run server` dev install or an existing Docker
one — `docker compose exec house-simulator-server` doesn't have `sqlite3`
in its slim runtime image, so run the script against a `docker cp`'d copy
of the `.db` file instead, or straight from the host if you can reach the
volume's mount point directly):
```bash
./scripts/export-house-data.sh /path/to/old/houseSimulator.db ./export.db
```
To import on the new install: stop `house-simulator-server` there
(`docker compose stop house-simulator-server`), copy `export.db` into its
`house-simulator-data` volume as `houseSimulator.db` (e.g. via a throwaway
container that mounts the same volume:
`docker run --rm -v <project>_house-simulator-data:/data -v "$(pwd)/export.db":/export.db alpine cp /export.db /data/houseSimulator.db`),
then start it back up. `migrate()` (`server/db.ts`) only ever adds
missing tables/columns, never touches existing data, so this is safe
regardless of version drift between the old and new install.

**wger**: use wger's own backup tooling, already part of the `wger/`
submodule — `wger/backup/backup-db.sh` (a `pg_dump --format custom`
dump, deliberately excluding regenerable data like sessions/thumbnails/
the powersync cache schema) plus the matching systemd timer/service for
scheduled backups. Restore procedure is documented on wger's own side:
<https://wger.readthedocs.io/en/latest/administration/backup.html>. If
you want wger's exercise library/settings but NOT the workout history
logged during development, restore the dump and then truncate
`workoutlog`/`workoutsession` (and any other personal-history tables) on
the new install's `db` service afterward, rather than bootstrapping from
nothing (which currently hits the bug noted above anyway).

## The code change the AW split required

`src/aw/client.ts` used to always connect to aw-server via `aw-client`'s own
default (`http://127.0.0.1:5600`) — correct for the non-Docker install,
where CLAUDE.md's "AW activity tracking" section notes `aw-server` "stays on
loopback relative to the Node server (same machine)." Once the Node server
and aw-server run as **separate containers**, loopback no longer reaches
anything — Compose's own service-name DNS is needed instead
(`http://aw-server:5600`, where `aw-server` is that service's name in
`docker-compose.yml`). `src/aw/client.ts` now reads `AW_HOST`/`AW_PORT` from
the environment and only overrides `aw-client`'s baseURL when `AW_HOST` is
actually set — `npm run server` run directly (no Docker, no env vars set)
behaves exactly as before. `docker-compose.yml` sets `AW_HOST=aw-server` on
the `house-simulator-server` service for exactly this reason.

## Why wger needed no equivalent networking change

Unlike AW, nothing in this codebase hardcodes a wger host/port at all —
`server/wger.ts` always reads `server_config.wger_base_url` (a plain
config value, same "hand-edited on the server" convention as
`broadcast_url`), so pointing it at `http://web:8000` (wger's Compose
service name) instead of `http://localhost:80` (a same-machine non-Docker
install) is just a config value, not a code change, once this stack puts
House Simulator and wger's `web` service on the same Docker network — see
"No explicit `networks:` needed" in `docker-compose.yml`'s own comment for
why that happens automatically (wger's own compose renames the whole
project's default network to `wger_network`, which every service here —
including ours — lands on without any extra configuration).

## Validation performed

Docker Desktop (29.9.2, Compose v5.6.1) was available in the sandbox this
was built in.

- `docker compose config` — well-formed; confirmed the merged `include:`
  model resolves wger's own relative paths (`../config/prod.env`,
  `./config-powersync`, ...) against the submodule's own location, not
  this repo's root, and confirmed `house-simulator-server`/`aw-server`
  land on the merged project's default network (named `wger_network` by
  wger's own compose) automatically with zero extra config.
- A full `docker compose up -d --build` against an **isolated test
  project** (separate `-p` project name and remapped host ports via an
  override file, specifically to avoid colliding with Jacqueline's
  already-running non-Docker wger stack on port 80 and the live dev
  `npm run server` on port 4000) — `db`/`cache` reached `healthy`,
  `aw-server` started and logged normally, `house-simulator-server`
  started and reached `/health` successfully (confirmed over the shared
  Compose network, no `AW_HOST` resolution issues), and `aw-server`'s own
  `/api/0/info` responded too. `wger`'s own `web` container hit the
  fresh-database bootstrap bug documented above — unrelated to anything
  in this repo's own two services, which both came up cleanly in the same
  run.
- Torn down with `-v` afterward (`docker compose -p <test-project> down -v`),
  confirmed via `docker ps` that Jacqueline's real, already-running wger
  stack (project name `docker`) was completely unaffected throughout.
- `scripts/export-house-data.sh` run against the real live database,
  output verified with `PRAGMA integrity_check` (`ok`) and spot-checked
  row counts (rooms/characters/goals) matching the live database exactly.
