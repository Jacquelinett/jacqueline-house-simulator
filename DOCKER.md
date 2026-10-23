# Running the stack on a home server via Docker

This packages the two always-on pieces that need to run 24/7 on a home
server, per `CLAUDE.md`'s "The Node server" and "AW activity tracking"
sections:

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

**wger is intentionally not part of this stack**, even though `server/wger.ts`
now talks to a real wger instance for real (the old hand-seeded mock mirror
in `server/workouts.ts` is gone — see CLAUDE.md's "wger integration"
section). It's already running independently (confirmed on this machine:
`docker ps` shows a `wger/server` stack defined at
`~/Programming/docker/docker-compose.yml`, on its own `wger_network`, nginx
published on host port 80), so bundling wger's own ~8-service compose stack
into this file would just duplicate work already done.

To actually reach that existing wger instance from inside the
`house-simulator-server` container, set `server_config.wger_base_url` (see
step 6 below) to `http://host.docker.internal:80` — **not**
`http://localhost:80`, which is what CLAUDE.md's wger section shows as the
example for a non-Docker install where the Node server and wger share one
real network namespace. Once the Node server is its own container,
`localhost` means the container itself; `docker-compose.yml`'s
`extra_hosts: host.docker.internal:host-gateway` on the
`house-simulator-server` service is what makes `host.docker.internal`
actually resolve to the real host machine instead (automatic on Docker
Desktop, needed explicitly on Linux). See that file's own closing comment
for the alternative (attaching to `wger_network` directly) if host-network
routing ever becomes a problem.

## First-time setup on a fresh machine

1. Install Docker (Docker Desktop, or plain Docker Engine + the compose
   plugin on Linux).
2. From the repo root: `docker compose up -d --build`. This builds the
   Node server image (multi-stage: `npm ci` + `npm run build` +
   `npm run build:admin` in a builder stage, a slimmed-down runtime stage
   underneath) and pulls the aw-server image.
3. Check both came up: `docker compose ps` (both should show `Up`), then
   `curl http://localhost:4000/health` should return `{"ok":true,...}`.
4. **Set the admin secret** (needed to reach `/admin/` at all — the server
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
5. **Set val.town broadcast credentials**, if you want the public viewer to
   work — same `UPDATE server_config SET broadcast_url = '...',
   broadcast_secret = '...' WHERE id = 1` pattern, once you have a
   val.town HTTP val running (see `valtown/houseSimulatorStatus.ts` and the
   main `README.md`'s "Public viewer (optional)" section — unrelated to
   Docker, still a one-time manual paste-into-val.town step either way).
6. **Set the wger base URL**, if you have a self-hosted wger instance you
   want linked (optional — null leaves the integration disabled for every
   character regardless of their own token): same `UPDATE server_config SET
   wger_base_url = 'http://host.docker.internal:80' WHERE id = 1` pattern as
   step 4/5 (see the wger paragraph above for why `host.docker.internal`,
   not `localhost`, from inside this container). Each character's own DRF
   API token is then set per-character through the admin tool's Characters
   tab (`characters.wger_api_token`), not here.
7. Point every device (the Tauri desktop app via `npm run tauri dev`/build,
   or a plain browser) at `http://<home-server-ip>:4000`. The admin tool is
   at `http://<home-server-ip>:4000/admin/`.

## What you need to edit before (or right after) first run

- **Ports** — `docker-compose.yml`'s `ports:` entries are `"<host>:<container>"`;
  change the host side (left of the colon) on either service if `4000` or
  `5600` collides with something already running on your home server.
  `4000` is the one port that matters for actual use (every device connects
  there); `5600` (aw-server's own web UI) is exposed only for convenience/
  debugging and can be removed from `ports:` entirely if you don't want
  AW's UI reachable from the LAN.
- **`platform: linux/amd64`** on the `aw-server` service — only needed on an
  arm64 host (Apple Silicon, Raspberry Pi, ...); the community image has no
  arm64 manifest (confirmed via `docker manifest inspect`). Delete that
  line if your home server is a plain x86_64 box, which is its native
  platform anyway. See that line's own comment in `docker-compose.yml` for
  the from-source fallback if emulation on an ARM host is ever a problem.
- **Secrets** (`admin_secret`, `broadcast_url`/`broadcast_secret`) — not env
  vars, see step 4/5 above. There's no `lan_secret` step needed anymore;
  WebSocket auth is per-character (`characters.secret`, see CLAUDE.md's
  "Characters" section), seeded automatically for the default "Jacqueline"
  character on first startup.
- **Volumes** — `house-simulator-data` (SQLite: goals/todos/characters/
  rooms/activities/server_config/...) and `aw-server-data` (AW's own
  buckets/events/settings) are both named volumes, so `docker compose down`
  (without `-v`) keeps everything across a restart/rebuild. Back these up
  the same way you'd back up any other Docker volume if you care about not
  losing tracked history.

## The code change this required

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
the `house-simulator-server` service for exactly this reason; validated
live in this sandbox (`docker compose up -d`, confirmed the Node server
container successfully created AW's stopwatch bucket over the Compose
network, then `docker compose down`).

## Validation performed

Docker Desktop (29.9.2) was available in the sandbox this was built in.
Ran, in order: `docker compose config` (well-formed), `docker compose build`
(succeeded — see the `Dockerfile`'s own comment on why `npm prune --omit=dev`
is used instead of a fresh `npm ci --omit=dev` in the runtime stage:
better-sqlite3 is a native module and the runtime stage has no compiler
toolchain), `docker compose up -d` (both containers reached `Up`), then:

- `curl http://localhost:4000/health` → `{"ok":true,"goalsCount":0}`
- `curl http://localhost:4000/` → the desktop app's `index.html`
- `curl http://localhost:4000/admin/` → `200`
- `curl http://localhost:5600/api/0/buckets/` → showed the
  `aw-stopwatch` bucket that `house-simulator-server` had just created
  *in the other container*, proving `AW_HOST=aw-server` actually resolved
  over Compose's network rather than silently falling back to loopback
  (which would have failed instead, since there's no aw-server on
  `house-simulator-server`'s own loopback at all in this topology)

Then `docker compose down` + removed the test image/volumes this produced,
so nothing from this validation run was left behind.
