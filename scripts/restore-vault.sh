#!/bin/sh
# Restores a Vault data-directory backup created by backup-vault.sh.
# Requires the vault container to be stopped first — restoring into a
# live, running Vault process would corrupt its on-disk state, since the
# process has file handles open against the directory being overwritten.
#
# Usage:
#   ./scripts/restore-vault.sh <backup-file.tar.gz> [compose-file]
set -eu

BACKUP_FILE="${1:?Usage: restore-vault.sh <backup-file.tar.gz> [compose-file]}"
COMPOSE_FILE="${2:-docker-compose.prod.yml}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file '$BACKUP_FILE' not found." >&2
  exit 1
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file '$COMPOSE_FILE' not found. Run this from the repo root, or pass the right path." >&2
  exit 1
fi

RUNNING=$(docker compose -f "$COMPOSE_FILE" ps -q vault)
if [ -n "$RUNNING" ]; then
  echo "The vault service is currently running. Stop it first:" >&2
  echo "  docker compose -f $COMPOSE_FILE stop vault" >&2
  exit 1
fi

echo "This will REPLACE the current Vault data directory contents."
echo "Type 'restore' to confirm: "
read -r CONFIRMATION
if [ "$CONFIRMATION" != "restore" ]; then
  echo "Confirmation did not match. Aborted, nothing was changed."
  exit 1
fi

ABS_BACKUP_FILE=$(cd "$(dirname "$BACKUP_FILE")" && pwd)/$(basename "$BACKUP_FILE")

# A stopped container has no running process to --volumes-from against, so
# this creates the container (without starting it) just to get a handle on
# its volumes, restores into them, then removes the placeholder container —
# `docker compose up -d vault` afterward starts the real one against the
# now-restored data.
docker compose -f "$COMPOSE_FILE" create vault
VAULT_CONTAINER_ID=$(docker compose -f "$COMPOSE_FILE" ps -a -q vault)

docker run --rm \
  --volumes-from "$VAULT_CONTAINER_ID" \
  -v "$ABS_BACKUP_FILE:/backup.tar.gz:ro" \
  alpine \
  sh -c "rm -rf /vault/file/* && tar xzf /backup.tar.gz -C /vault/file"

echo "Restore complete. Start Vault:"
echo "  docker compose -f $COMPOSE_FILE up -d vault"
echo "You will need the unseal key(s) from when this backup's Vault instance"
echo "was originally initialized — restoring the data directory alone does"
echo "not unseal it automatically."
