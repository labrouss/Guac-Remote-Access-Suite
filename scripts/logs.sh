#!/bin/sh
# Grabs recent logs from every guac-access-suite container in one shot —
# for development/troubleshooting, not part of the app itself. Requested
# directly: the amount of back-and-forth "run docker logs X, now run
# docker logs Y" this session took made a single script worth having.
#
# Usage:
#   ./scripts/logs.sh              # last 50 lines from each container
#   ./scripts/logs.sh 200          # last 200 lines from each
#   ./scripts/logs.sh -f           # follow mode, all containers interleaved
#   ./scripts/logs.sh -f 200       # follow mode, starting with 200 lines of backlog
set -eu

# docker-compose.yml, not any specific dev/prod file — same convention as
# scripts/vault-init.sh and scripts/reset-setup-lockout.sh, all assuming
# this repo's standard local copy. `docker compose logs` (not plain
# `docker logs`) is what actually handles multiple services correctly in
# one call, with each line prefixed by which service it came from.
COMPOSE_FILE="docker-compose.yml"
if [ ! -f "$COMPOSE_FILE" ]; then
	echo "$COMPOSE_FILE not found. Run this from the same directory as your compose file." >&2
	exit 1
fi

FOLLOW=""
LINES="50"
for arg in "$@"; do
	if [ "$arg" = "-f" ]; then
		FOLLOW="-f"
	else
		LINES="$arg"
	fi
done

if [ -n "$FOLLOW" ]; then
	echo "Following all containers (Ctrl+C to stop) — last $LINES lines of backlog first:"
	docker compose -f "$COMPOSE_FILE" logs -f --tail "$LINES"
else
	docker compose -f "$COMPOSE_FILE" logs --tail "$LINES"
fi
