#!/bin/sh
# Restores a recordings backup created by backup-recordings.sh. Requires
# `backend` and `guac-worker` to both be stopped first — the same
# reasoning as restore-vault.sh's identical requirement: replacing this
# volume's contents while either container might still have an open file
# handle against a file being overwritten (a recording actively being
# streamed for playback, or actively being written by a just-finished
# session) risks a torn or inconsistent result, not a guaranteed-clean one.
#
# Usage:
#   ./scripts/restore-recordings.sh <backup-file.tar.gz> [compose-file]
set -eu

BACKUP_FILE="${1:?Usage: restore-recordings.sh <backup-file.tar.gz> [compose-file]}"
COMPOSE_FILE="${2:-docker-compose.prod.yml}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file '$BACKUP_FILE' not found." >&2
  exit 1
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file '$COMPOSE_FILE' not found. Run this from the repo root, or pass the right path." >&2
  exit 1
fi

RUNNING_BACKEND=$(docker compose -f "$COMPOSE_FILE" ps -q backend)
RUNNING_WORKER=$(docker compose -f "$COMPOSE_FILE" ps -q guac-worker)
if [ -n "$RUNNING_BACKEND" ] || [ -n "$RUNNING_WORKER" ]; then
  echo "The backend and/or guac-worker service is currently running. Stop both first:" >&2
  echo "  docker compose -f $COMPOSE_FILE stop backend guac-worker" >&2
  exit 1
fi

echo "This will REPLACE the current contents of the recordings volume."
echo "Type 'restore' to confirm: "
read -r CONFIRMATION
if [ "$CONFIRMATION" != "restore" ]; then
  echo "Confirmation did not match. Aborted, nothing was changed."
  exit 1
fi

ABS_BACKUP_FILE=$(cd "$(dirname "$BACKUP_FILE")" && pwd)/$(basename "$BACKUP_FILE")

# Same placeholder-container pattern as restore-vault.sh: a stopped
# container has no running process to --volumes-from against, so this
# creates backend (without starting it) just to get a handle on its
# volumes, restores into them, then removes the placeholder — `docker
# compose up -d` afterward starts the real services against the now-
# restored data.
docker compose -f "$COMPOSE_FILE" create backend
BACKEND_CONTAINER_ID=$(docker compose -f "$COMPOSE_FILE" ps -a -q backend)

docker run --rm \
  --volumes-from "$BACKEND_CONTAINER_ID" \
  -v "$ABS_BACKUP_FILE:/backup.tar.gz:ro" \
  alpine \
  sh -c "rm -rf /data/recordings/* && tar xzf /backup.tar.gz -C /data/recordings"

echo "Restore complete. Start the stack back up:"
echo "  docker compose -f $COMPOSE_FILE up -d backend guac-worker"
echo ""
echo "NOTE: this restores recording files only. If you're restoring after"
echo "a disaster (not just testing recovery), also restore a Postgres"
echo "backup from around the same time — a recording file with no matching"
echo "metadata row won't show up anywhere in the app's own recordings list,"
echo "and a metadata row with no matching file will show up but fail to play."
