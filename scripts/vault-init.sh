#!/bin/sh
# Initializes, unseals, and bootstraps Vault's Transit + AppRole for a
# plain `docker compose` deployment (docker-compose.dev.yml or
# docker-compose.prod.yml) — run this once after `docker compose up -d`,
# any time Vault comes up freshly initialized (a new deployment, or after
# wiping the `vaultdata` volume). Re-running it is safe: it detects and
# skips whatever's already done.
#
# Same underlying logic as buildroot/board/guac-appliance/
# rootfs-overlay/usr/bin/guac-appliance-vault-setup.sh (written for the
# Buildroot appliance) — this is the equivalent for everyone else, since a
# real, previously-missing gap: nothing in the regular docker-compose
# deployment path ever bootstrapped Vault, unlike the appliance. Confirmed
# as a real, live-blocking issue: Vault coming up cleanly (after fixing
# the duplicate -config bug) still left the setup wizard's TOTP enrollment
# failing, because a freshly-started file-storage Vault is uninitialized
# and sealed by default, with no AppRole configured at all.
#
# Run from the HOST (needs docker + docker compose), not inside a
# container — uses `docker compose exec` against the running vault
# service.
set -e

ENV_FILE="${1:-.env}"
KEYS_FILE="./vault-init-keys.txt"

log() { echo "[vault-init] $*"; }

# The `vault` CLI defaults to https://127.0.0.1:8200 when VAULT_ADDR isn't
# set — but our server speaks plain HTTP (vault-config.hcl's
# tls_disable = 1), and the vault container itself has no VAULT_ADDR env
# var set. Every CLI call in this script goes through this helper
# specifically so that's never missed on any one of them — found as a
# real bug on this script's very first real run: every earlier call
# (the readiness check, the status check) was silently failing the same
# way and falling back to empty/default values without an obviously
# visible error, until `vault operator init` finally printed one plainly:
# `Get "https://127.0.0.1:8200/v1/sys/seal-status": http: server gave
# HTTP response to HTTPS client`.
vexec() {
	docker compose exec -T -e VAULT_ADDR=http://127.0.0.1:8200 "$@"
}

if [ ! -f "$ENV_FILE" ]; then
	echo "Error: $ENV_FILE not found. Run this from the same directory as your docker-compose.yml / .env, or pass the path as an argument." >&2
	exit 1
fi

log "Waiting for Vault's API to respond..."
for _ in $(seq 1 30); do
	# `cmd || status_code=$?`, not a bare command followed by a separate
	# `$?` check — found as a real bug on this exact line, the second time
	# around: under `set -e`, a bare statement that returns non-zero
	# aborts the whole script immediately, silently, before the next line
	# even runs. Vault returning exit 2 here (sealed, completely expected
	# at this point) was triggering exactly that — the script exited with
	# no error message right after the very first log line. The `||`
	# protects the statement from triggering `set -e`, the same way it
	# does for the deliberate `|| true` calls further down.
	status_code=0
	vexec vault vault status >/dev/null 2>&1 || status_code=$?
	# 0 (unsealed+active) or 2 (reachable but sealed) both mean the API
	# genuinely responded; only 1 (can't connect at all) means retry.
	if [ "$status_code" = "0" ] || [ "$status_code" = "2" ]; then break; fi
	sleep 2
done

STATUS_JSON=$(vexec vault vault status -format=json 2>/dev/null || echo '{}')
# Flattened as a SEPARATE step, not piped directly into the capture above
# — `cmd1 | cmd2`'s exit status is cmd2's (tr, which almost always
# succeeds), which would silently mask a genuine failure of the actual
# vault command and defeat the `|| echo '{}'` fallback above. Checked
# for specifically after catching the underlying reason this flattening
# is needed at all in the first place — didn't want to introduce a new,
# quieter bug while fixing a loud one.
STATUS_JSON=$(echo "$STATUS_JSON" | tr -d '\n')
INITIALIZED=$(echo "$STATUS_JSON" | sed -n 's/.*"initialized": *\(true\|false\).*/\1/p')
SEALED=$(echo "$STATUS_JSON" | sed -n 's/.*"sealed": *\(true\|false\).*/\1/p')

if [ "$INITIALIZED" != "true" ]; then
	log "Vault has never been initialized — running operator init (single key share)."
	log "NOTE: a single unseal key share is appropriate for a small, single-operator"
	log "deployment. For anything larger, consider re-running this with more shares"
	log "and a real threshold, distributed to multiple people."
	# Vault's own -format=json output is pretty-printed across multiple
	# lines (confirmed against a real example in a HashiCorp GitHub
	# issue: `"unseal_keys_b64": [` and the actual key string sit on
	# DIFFERENT lines), not compact single-line JSON as these sed
	# patterns originally assumed. That silently extracted nothing for
	# UNSEAL_KEY specifically (an array value, unlike root_token's simple
	# scalar, which happened to still work by coincidence) — found live:
	# `vault operator unseal ""` fell back to an interactive terminal
	# prompt, which fails outright with no TTY available (`file
	# descriptor 0 is not a terminal`). Flattened as a separate step
	# after capture, same reasoning as STATUS_JSON above — a genuine
	# `operator init` failure needs to still abort the script via set -e,
	# which piping directly through tr would have silently prevented.
	INIT_JSON=$(vexec vault vault operator init -key-shares=1 -key-threshold=1 -format=json)
	INIT_JSON=$(echo "$INIT_JSON" | tr -d '\n')
	UNSEAL_KEY=$(echo "$INIT_JSON" | sed -n 's/.*"unseal_keys_b64": *\[ *"\([^"]*\)".*/\1/p')
	ROOT_TOKEN=$(echo "$INIT_JSON" | sed -n 's/.*"root_token": *"\([^"]*\)".*/\1/p')

	umask 077
	cat > "$KEYS_FILE" <<-EOF
	# Vault unseal key and initial root token for this deployment, generated
	# once at first Vault initialization. RETRIEVE THIS FILE AND STORE IT
	# SOMEWHERE SECURE — this is the key that unseals the credential vault
	# protecting every connection this app manages. This script does not
	# delete it automatically; remove it yourself once you've confirmed you
	# have it safely stored elsewhere.
	#
	# Vault's own file-storage backend seals again every time its container
	# restarts (a VM reboot, `docker compose restart`, anything) — you'll
	# need this key again then. Re-run this script; it detects Vault is
	# already initialized and just unseals + confirms the AppRole.
	VAULT_UNSEAL_KEY=$UNSEAL_KEY
	VAULT_ROOT_TOKEN=$ROOT_TOKEN
	EOF
	log "Vault initialized. Unseal key and root token written to $KEYS_FILE — see the warning in that file."
elif [ ! -f "$KEYS_FILE" ]; then
	echo "Error: Vault is already initialized, but $KEYS_FILE is missing — cannot unseal or bootstrap the AppRole automatically. If you still have the unseal key/root token from when this instance was first initialized, create $KEYS_FILE manually with VAULT_UNSEAL_KEY=... and VAULT_ROOT_TOKEN=... lines, then re-run this script." >&2
	exit 1
fi

if [ "$SEALED" != "false" ]; then
	UNSEAL_KEY=$(sed -n 's/^VAULT_UNSEAL_KEY=//p' "$KEYS_FILE")
	log "Unsealing Vault."
	vexec vault vault operator unseal "$UNSEAL_KEY" >/dev/null
fi

ROOT_TOKEN=$(sed -n 's/^VAULT_ROOT_TOKEN=//p' "$KEYS_FILE")

log "Bootstrapping Transit engine + AppRole (safe to re-run — each step is idempotent)."
vexec -e VAULT_TOKEN="$ROOT_TOKEN" vault vault secrets enable -path=transit transit 2>/dev/null || true
vexec -e VAULT_TOKEN="$ROOT_TOKEN" vault vault write -f transit/keys/guac-credentials >/dev/null 2>&1 || true
vexec -e VAULT_TOKEN="$ROOT_TOKEN" vault vault auth enable approle 2>/dev/null || true

vexec -e VAULT_TOKEN="$ROOT_TOKEN" vault sh -c 'vault policy write guac-app - <<POLICY
path "transit/encrypt/guac-credentials" { capabilities = ["update"] }
path "transit/decrypt/guac-credentials" { capabilities = ["update"] }
POLICY'

vexec -e VAULT_TOKEN="$ROOT_TOKEN" vault vault write auth/approle/role/guac-app \
	token_policies="guac-app" \
	token_ttl=1h \
	token_max_ttl=4h >/dev/null

ROLE_ID=$(vexec -e VAULT_TOKEN="$ROOT_TOKEN" vault vault read -field=role_id auth/approle/role/guac-app/role-id)
SECRET_ID=$(vexec -e VAULT_TOKEN="$ROOT_TOKEN" vault vault write -f -field=secret_id auth/approle/role/guac-app/secret-id)
# docker compose exec's own output can carry a trailing \r on some hosts —
# strip it so it doesn't end up embedded in the .env value.
ROLE_ID=$(echo "$ROLE_ID" | tr -d '\r\n')
SECRET_ID=$(echo "$SECRET_ID" | tr -d '\r\n')

if grep -q "^VAULT_ROLE_ID=" "$ENV_FILE"; then
	sed -i.bak "s|^VAULT_ROLE_ID=.*|VAULT_ROLE_ID=$ROLE_ID|" "$ENV_FILE"
else
	echo "VAULT_ROLE_ID=$ROLE_ID" >> "$ENV_FILE"
fi
if grep -q "^VAULT_SECRET_ID=" "$ENV_FILE"; then
	sed -i.bak "s|^VAULT_SECRET_ID=.*|VAULT_SECRET_ID=$SECRET_ID|" "$ENV_FILE"
else
	echo "VAULT_SECRET_ID=$SECRET_ID" >> "$ENV_FILE"
fi
rm -f "$ENV_FILE.bak"

log "AppRole credentials written to $ENV_FILE."
log "Restarting backend so it picks up the new credentials (env vars are only read at container creation, not reloaded live)."
docker compose up -d --force-recreate backend

# frontend too, not just backend — nginx resolves the "backend" upstream
# hostname once, at its own startup, not per-request. If frontend was
# already running before this script force-recreated backend (true for
# any redeploy script that does `docker compose up -d --build` and then
# runs this script afterward, which is exactly how this is meant to be
# used), frontend's nginx would be left holding backend's now-stale IP —
# reproducing the exact 502 "Bad Gateway" this project hit and diagnosed
# earlier, on every single future run of this script, not just once.
log "Restarting frontend too, so its nginx re-resolves backend's new address."
docker compose up -d --force-recreate frontend

log "Done. Vault is unsealed and the backend has fresh AppRole credentials."
