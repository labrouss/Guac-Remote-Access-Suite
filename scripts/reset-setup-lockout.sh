#!/bin/sh
# Emergency recovery: reopens the first-time setup wizard, for the one
# situation this app previously had no recovery path for at all — the
# sole admin account's TOTP secret becoming permanently undecryptable
# (e.g. Vault got re-initialized with a new Transit key at some point
# after the secret was originally encrypted; a new key means the old
# ciphertext can never be recovered, by Vault's own design, not a bug).
# `setup_completed` is otherwise correctly permanent once true — there
# was genuinely no way back through the app itself before this script.
#
# Once run, POST /api/setup/admin becomes reachable again. If you sign
# back in with the SAME username as before, this app's own setup route
# treats that as *resuming* an interrupted setup (see routes/setup.ts's
# setupAdmin — the same logic that already handles a setup wizard
# interrupted mid-flow): it updates that account's password and lets you
# re-enroll a fresh TOTP secret, rather than erroring or creating a
# second account. A DIFFERENT username would create a genuinely new
# admin account instead — the existing one stays as-is either way.
#
# SECURITY NOTE, read before running: for as long as the wizard is
# reopened, anyone who can reach it could create their own admin account
# (if they don't know your existing username) or take over the existing
# one (if they do, via the resume behavior above). Only run this when
# you're confident the app isn't reachable by anyone untrusted right
# now, and complete the wizard again immediately rather than leaving it
# open.
#
# Usage:
#   ./scripts/reset-setup-lockout.sh [compose-file]
set -eu

# docker-compose.yml, not docker-compose.prod.yml — unlike
# backup-postgres.sh/restore-postgres.sh (which default to the prod
# file), this matches whatever Docker Compose itself defaults to with no
# -f given at all, and what scripts/vault-init.sh already assumes via its
# own bare `docker compose` calls — the more relevant consistency point
# for a script that's really this one's companion, not backup/restore's.
COMPOSE_FILE="${1:-docker-compose.yml}"
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

echo "This will reopen the first-time setup wizard for this deployment."
echo "Read the security note in this script's own header before continuing."
printf "Type 'reopen' to confirm: "
read -r CONFIRM
if [ "$CONFIRM" != "reopen" ]; then
	echo "Aborted — nothing changed."
	exit 1
fi

docker compose -f "$COMPOSE_FILE" exec -T postgres \
	psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
	-c "UPDATE system_config SET setup_completed = false, setup_completed_at = NULL WHERE id = true;"

echo "Done. The setup wizard is reachable again — complete it now."
