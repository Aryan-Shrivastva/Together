#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env.production ]]; then
  echo 'Create .env.production from .env.production.example before deploying.' >&2
  exit 1
fi

compose=(docker compose --env-file .env.production -f docker-compose.production.yml)
"${compose[@]}" config --quiet
# Build sequentially so a small demo VM does not run Go and Node builds together.
for service in minio runtime-image docker-proxy migrate server client; do
  "${compose[@]}" build "$service"
done
"${compose[@]}" up -d --wait --wait-timeout 180
"${compose[@]}" ps
