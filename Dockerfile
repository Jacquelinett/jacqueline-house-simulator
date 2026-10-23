# Packages the Node server (server/index.ts) — the "always-on backend" from
# CLAUDE.md's "The Node server" section. This is the only piece of the five
# things in this repo that makes sense to containerize for a home server:
# it owns AW/SQLite/val.town and serves both the desktop app's dist/ build
# and the admin tool's dist-admin/ build over plain HTTP (see CLAUDE.md's
# "One build, two delivery mechanisms"). The Tauri desktop app itself is
# never built or run here — that stays a normal `npm run tauri dev`/build on
# whatever machine someone actually sits in front of.
#
# Multi-stage: the builder stage needs the full devDependencies (vite,
# typescript, @tauri-apps/cli) to produce dist/ and dist-admin/; the runtime
# stage only needs the production dependencies (tsx to run server/*.ts
# directly without a separate compile step, aw-client, better-sqlite3, ws)
# plus the already-built static output and the TS source tsx executes.

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# python3/make/g++ let better-sqlite3's install step compile from source if
# no prebuilt binary matches this exact image's glibc/arch — cheap insurance,
# usually a no-op since prebuilt binaries cover linux-x64/arm64 glibc.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Builds the desktop app's dist/ (also what the server serves to plain
# browsers) and the admin tool's dist-admin/ — see CLAUDE.md's Commands.
# Does NOT run build:viewer (dist-viewer/ is GitHub-Pages-only, never
# served by this server — see CLAUDE.md's "GitHub Pages deployment").
RUN npm run build && npm run build:admin

# Strips devDependencies (vite, typescript, @tauri-apps/cli, ...) out of
# this stage's own node_modules in place, rather than re-running `npm ci
# --omit=dev` from scratch in the runtime stage below. better-sqlite3 is a
# native module with no prebuilt binary for every platform (confirmed: it
# fails to compile in a fresh runtime-stage `npm install` here without
# python3/make/g++ present) — reusing the copy already compiled just above,
# where those build tools exist, avoids needing them in the final image too.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules

# Static output from the builder stage.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-admin ./dist-admin

# server/ and src/ themselves — tsx (a runtime dependency, see package.json)
# transpiles/runs these .ts files directly rather than needing a separate
# `tsc` emit step. src/ is needed because server/*.ts imports straight from
# it (src/aw/client.ts, src/goals/recurrence.ts, ...) — see CLAUDE.md's "The
# Node server" for why so much of this moved into server/ unchanged rather
# than being rewritten.
COPY server ./server
COPY src ./src

# server/db.ts resolves its SQLite file to <dirname of server/db.ts>/data,
# i.e. /app/server/data here — mount a volume there so the database (and
# the hand-edited server_config row — broadcast/admin/lan secrets) survive
# a container recreation. See docker-compose.yml.
VOLUME ["/app/server/data"]

EXPOSE 4000

# Runs server/index.ts directly via tsx, same entry point `npm run server`
# uses in dev (minus --watch, which isn't wanted in a long-running
# container — a code change here means rebuilding the image, not hot-reload).
CMD ["npx", "tsx", "server/index.ts"]
