#!/usr/bin/env bash
#
# Exports House Simulator's SQLite database (rooms/objects/activities/
# goals/todos/characters incl. wger tokens/device_settings/server_config)
# as one consistent snapshot file — the real source of truth to carry
# over to a new install, e.g. when standing up the home-server Docker
# stack (see DOCKER.md's "Migrating data to a new install" section).
#
# Uses sqlite3's own `.backup` command (SQLite's online backup API, not a
# plain file copy) specifically so this is safe to run WHILE the server
# is live and actively writing — it produces a complete, consistent
# snapshot regardless of what's mid-transaction or sitting in the WAL
# file at the moment this runs, unlike copying houseSimulator.db directly
# (which could copy a stale page, or miss whatever's only in
# houseSimulator.db-wal so far).
#
# Usage:
#   ./scripts/export-house-data.sh [source-db-path] [output-path]
#
#   source-db-path  default: server/data/houseSimulator.db (this repo's
#                   own dev DB path) — point this at wherever the real
#                   live install's data actually lives, e.g.
#                   /app/server/data/houseSimulator.db if run via
#                   `docker compose exec house-simulator-server sh -c
#                   '/app/scripts/export-house-data.sh'` against a running
#                   container (sqlite3 isn't installed in the slim runtime
#                   image by default — see DOCKER.md for the alternative
#                   `docker cp` + run-locally approach if that matters).
#   output-path     default: server/data/backups/houseSimulator.export.<timestamp>.db
#                   same backups/ directory this app's own one-off manual
#                   migrations already used tonight, so exports and
#                   pre-migration safety backups live in one obvious place.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(dirname "$SCRIPT_DIR")

SOURCE_DB=${1:-"$REPO_ROOT/server/data/houseSimulator.db"}
DEFAULT_OUTPUT_DIR="$REPO_ROOT/server/data/backups"
OUTPUT_PATH=${2:-"$DEFAULT_OUTPUT_DIR/houseSimulator.export.$(date +%Y%m%d-%H%M%S).db"}

if [[ ! -f "$SOURCE_DB" ]]; then
  echo "error: source database not found: $SOURCE_DB" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "error: sqlite3 CLI not found — install it (e.g. 'brew install sqlite3') or run this" >&2
  echo "       against a copy of the .db file somewhere sqlite3 IS available." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_PATH")"

echo "Exporting $SOURCE_DB -> $OUTPUT_PATH ..."
sqlite3 "$SOURCE_DB" ".backup '$OUTPUT_PATH'"

echo "Done: $(du -h "$OUTPUT_PATH" | cut -f1) -> $OUTPUT_PATH"
echo
echo "To import on the new install, see DOCKER.md's \"Migrating data to a new install\" section —"
echo "short version: stop the house-simulator-server container, copy this file into its"
echo "house-simulator-data volume as houseSimulator.db, then start it back up."
