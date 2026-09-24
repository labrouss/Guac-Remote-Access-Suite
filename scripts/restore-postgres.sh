#!/bin/sh
# Restores a Postgres dump created by backup-postgres.sh. Destructive —
# requires typing the database name back to confirm, same pattern as
# `terraform destroy` and similar irreversible-action tools, since a
# restore overwrites whatever is currently in the database.
#
# Usage:
#   ./scripts/restore-postgres.sh <dump-file.sql.gz> [compose-file]
set -eu

DUMP_FILE="${1:?Usage: restore-postgres.sh <dump-file.sql.gz> [compose-file]}"
COMPOSE_FILE="${2:-docker-compose.prod.yml}"

if [ ! -f "$DUMP_FILE" ]; then
  echo "Dump file '$DUMP_FILE' not found." >&2
  exit 1
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file '$COMPOSE_FILE' not found. Run this from the repo root, or pass the right path." >&2
  exit 1
fi

if [ -f .env ]; then
  POSTGRES_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)
  POSTGRES_DB=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)
fi
POSTGRES_USER="${POSTGRES_USER:-guac_app}"
POSTGRES_DB="${POSTGRES_DB:-guac_access_suite}"

echo "This will OVERWRITE the current contents of database '$POSTGRES_DB'."
echo "Type the database name to confirm: "
read -r CONFIRMATION
if [ "$CONFIRMATION" != "$POSTGRES_DB" ]; then
  echo "Confirmation did not match. Aborted, nothing was changed."
  exit 1
fi

echo "Restoring $DUMP_FILE into $POSTGRES_DB ..."
gunzip -c "$DUMP_FILE" | docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U "$POSTGRES_USER" "$POSTGRES_DB"

echo "Restore complete. Restart the backend container so it picks up any"
echo "connections that were mid-flight during the restore:"
echo "  docker compose -f $COMPOSE_FILE restart backend"
