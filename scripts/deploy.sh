#!/usr/bin/env bash
#
# Deploys the latest code to this machine's Docker stack — run this ON the
# home server itself (it operates on whatever repo checkout it's run from),
# not from a dev machine. See DOCKER.md's "Deploying an update" section for
# the full explanation of what each step actually does and why.
#
# What this does NOT do: touch any data. house-simulator-data/aw-server-data/
# wger's own volumes are all untouched by every step below — only
# house-simulator-server's own image gets rebuilt, and only that one
# container gets recreated, since nothing about aw-server/wger's `image:`
# references ever changes here.
#
# Usage: ./scripts/deploy.sh [--update-wger]
#
#   --update-wger   also runs `git submodule update --remote` to pull
#                    wger's own upstream changes (normally you only want
#                    `--init`, i.e. "make sure the submodule is checked
#                    out at whatever commit this repo currently points
#                    to" — this flag additionally moves that pointer
#                    forward to wger's latest, which is a separate,
#                    deliberate decision, not something every deploy
#                    should do by default).

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(dirname "$SCRIPT_DIR")
cd "$REPO_ROOT"

UPDATE_WGER=false
for arg in "$@"; do
  case "$arg" in
    --update-wger) UPDATE_WGER=true ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

echo "==> git pull"
git pull

if [[ "$UPDATE_WGER" == true ]]; then
  echo "==> git submodule update --remote (pulling wger's latest upstream commit)"
  git submodule update --remote wger
else
  echo "==> git submodule update --init (checking out whatever commit this repo currently points wger/ at)"
  git submodule update --init
fi

echo "==> docker compose up -d --build"
docker compose up -d --build

echo
echo "Done. docker compose ps:"
docker compose ps
