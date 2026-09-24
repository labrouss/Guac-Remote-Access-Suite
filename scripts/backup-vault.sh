#!/bin/sh
# Backs up Vault's file-storage data directory. Our vault-config.hcl uses
# `storage "file"` (not Raft integrated storage), so there's no
# `vault operator raft snapshot` available — the equivalent for file
# storage is backing up the data directory itself.
#
# Uses `docker run --volumes-from <vault-container>` rather than the volume
# name directly (e.g. `guac-access-suite_vaultdata`) — the actual name is
# prefixed by the Compose project name, which varies by directory/deployment,
# so mounting via the running container's own volumes is what makes this
# work the same way regardless of that prefix.
#
# IMPORTANT: this is a live backup of a running Vault — file storage isn't
# guaranteed crash-consistent under concurrent writes the way a database's
# own dump tooling is. For anything beyond routine backups, consider a
# brief `docker compose stop vault` around this script, accepting a short
# availability gap, for a guaranteed-consistent snapshot.
#
# Usage:
#   ./scripts/backup-vault.sh [compose-file] [output-dir]
set -eu

COMPOSE_FILE="${1:-docker-compose.prod.yml}"
OUTPUT_DIR="${2:-./backups}"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file '$COMPOSE_FILE' not found. Run this from the repo root, or pass the right path." >&2
  exit 1
fi

VAULT_CONTAINER_ID=$(docker compose -f "$COMPOSE_FILE" ps -q vault)
if [ -z "$VAULT_CONTAINER_ID" ]; then
  echo "No running 'vault' service found for $COMPOSE_FILE — is the stack up?" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
ABS_OUTPUT_DIR=$(cd "$OUTPUT_DIR" && pwd)
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUTPUT_FILE="vault-${TIMESTAMP}.tar.gz"

echo "Backing up Vault data (container $VAULT_CONTAINER_ID) to $OUTPUT_DIR/$OUTPUT_FILE ..."
docker run --rm \
  --volumes-from "$VAULT_CONTAINER_ID" \
  -v "$ABS_OUTPUT_DIR:/backup" \
  alpine \
  tar czf "/backup/$OUTPUT_FILE" -C /vault/file .

echo "Done: $OUTPUT_DIR/$OUTPUT_FILE ($(du -h "$OUTPUT_DIR/$OUTPUT_FILE" | cut -f1))"
echo "Restore with: ./scripts/restore-vault.sh $OUTPUT_DIR/$OUTPUT_FILE $COMPOSE_FILE"
echo ""
echo "NOTE: this backs up Vault's own encrypted data-at-rest — it does NOT"
echo "include the unseal key or root token, which you must have stored"
echo "separately (per the setup guidance) for a restored Vault to be usable."
