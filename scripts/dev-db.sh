#!/usr/bin/env bash
# Start the local dev Postgres via docker compose and wait until it's ready.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Starting postgres container (docker compose up -d postgres)"
docker compose up -d postgres

echo "==> Waiting for postgres to accept connections"
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U sf -d software_factory >/dev/null 2>&1; then
    echo "==> Postgres is ready (attempt $i)"
    exit 0
  fi
  sleep 1
done

echo "!! Postgres did not become ready within 30s" >&2
docker compose ps postgres
exit 1