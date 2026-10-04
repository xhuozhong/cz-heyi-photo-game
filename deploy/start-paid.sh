#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  echo 'Copy .env.example to .env and configure the server first. Defaults keep payments disabled.' >&2
  exit 1
fi
exec node --env-file=.env backend/server.mjs
