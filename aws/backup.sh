#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
output="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$output"
compose=(docker compose --env-file .env.production -f docker-compose.production.yml)
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$output/database.dump"
"${compose[@]}" exec -T server tar -czf - -C /data workspaces > "$output/workspaces.tar.gz"
"${compose[@]}" exec -T minio tar -czf - -C /data . > "$output/object-storage.tar.gz"
printf 'Backup written to %s. Copy it off the VM and keep the production encryption keys separately.\n' "$output"
