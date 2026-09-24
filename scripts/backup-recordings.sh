#!/bin/sh
# Backs up the `recordings` named volume — session recording files, kept
# separately from Postgres (which only stores each recording's own
# metadata row: who, when, which connection) and from Vault (which never
# touches recordings at all). Neither of the other two backup scripts
# covers this data; a restore of Postgres + Vault alone brings back every
# recording's *metadata* with no way to actually play any of them back,
# since the underlying files themselves live only in this volume.
#
# Uses `docker run --volumes-from <container>` against the `backend`
# service, the same reasoning as backup-vault.sh's identical choice: the
# volume's real Compose-prefixed name varies by deployment, so mounting
# via a running container's own volumes is what makes this work
# regardless of that prefix. `backend` and `guac-worker` both mount this
# volume identically (docker-compose.prod.yml) — `backend` is used here
# only because it's guaranteed to already be running for the rest of the
# app to function at all, not because of anything specific to it.
#
# This is a live backup of files that are only ever written once, when a
# recording finishes (see recordings' own write path) — not files under
# continuous modification the way a database's own storage is, so unlike
# Vault's live-backup caveat, there's no ongoing-write consistency risk
# here beyond the one session recording (if any) that happens to still be
# actively in progress at the exact moment this runs; that one recording
# may be incomplete in this backup, but every other, already-finished
# recording is unaffected.
#
# Usage:
#   ./scripts/backup-recordings.sh [compose-file] [output-dir]
set -eu

COMPOSE_FILE="${1:-docker-compose.prod.yml}"
OUTPUT_DIR="${2:-./backups}"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file '$COMPOSE_FILE' not found. Run this from the repo root, or pass the right path." >&2
  exit 1
fi

BACKEND_CONTAINER_ID=$(docker compose -f "$COMPOSE_FILE" ps -q backend)
if [ -z "$BACKEND_CONTAINER_ID" ]; then
  echo "No running 'backend' service found for $COMPOSE_FILE — is the stack up?" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
ABS_OUTPUT_DIR=$(cd "$OUTPUT_DIR" && pwd)
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUTPUT_FILE="recordings-${TIMESTAMP}.tar.gz"

echo "Backing up recordings (container $BACKEND_CONTAINER_ID) to $OUTPUT_DIR/$OUTPUT_FILE ..."
docker run --rm \
  --volumes-from "$BACKEND_CONTAINER_ID" \
  -v "$ABS_OUTPUT_DIR:/backup" \
  alpine \
  tar czf "/backup/$OUTPUT_FILE" -C /data/recordings .

echo "Done: $OUTPUT_DIR/$OUTPUT_FILE ($(du -h "$OUTPUT_DIR/$OUTPUT_FILE" | cut -f1))"
echo "Restore with: ./scripts/restore-recordings.sh $OUTPUT_DIR/$OUTPUT_FILE $COMPOSE_FILE"
echo ""
echo "NOTE: this backs up recording files only — each recording's own"
echo "metadata (who made it, when, which connection) lives in Postgres,"
echo "not here. Restoring recordings without also restoring a matching"
echo "Postgres backup leaves files on disk with no matching database rows,"
echo "so they won't appear anywhere in the app's own recordings list."
