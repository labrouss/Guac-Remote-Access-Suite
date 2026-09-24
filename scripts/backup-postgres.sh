#!/bin/sh
# Backs up Postgres via pg_dump run inside the already-running compose
# container (docker compose exec), rather than assuming a volume name or a
# directly-reachable host/port — works the same way regardless of which
# compose file (dev/prod/test) or Docker network layout is in use.
#
# Usage:
#   ./scripts/backup-postgres.sh [compose-file] [output-dir]
# Defaults: compose-file=docker-compose.prod.yml, output-dir=./backups
set -eu

COMPOSE_FILE="${1:-docker-compose.prod.yml}"
OUTPUT_DIR="${2:-./backups}"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file '$COMPOSE_FILE' not found. Run this from the repo root, or pass the right path." >&2
  exit 1
fi

# .env holds POSTGRES_USER/POSTGRES_DB — read directly rather than requiring
# them to already be exported, since this is typically run standalone (e.g.
# from cron), not from a shell that's sourced .env itself.
if [ -f .env ]; then
  POSTGRES_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)
  POSTGRES_DB=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)
fi
POSTGRES_USER="${POSTGRES_USER:-guac_app}"
POSTGRES_DB="${POSTGRES_DB:-guac_access_suite}"

mkdir -p "$OUTPUT_DIR"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUTPUT_FILE="$OUTPUT_DIR/postgres-${TIMESTAMP}.sql.gz"

echo "Backing up Postgres (db=$POSTGRES_DB, user=$POSTGRES_USER) to $OUTPUT_FILE ..."
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$OUTPUT_FILE"

echo "Done: $OUTPUT_FILE ($(du -h "$OUTPUT_FILE" | cut -f1))"
echo "Restore with: ./scripts/restore-postgres.sh $OUTPUT_FILE $COMPOSE_FILE"
