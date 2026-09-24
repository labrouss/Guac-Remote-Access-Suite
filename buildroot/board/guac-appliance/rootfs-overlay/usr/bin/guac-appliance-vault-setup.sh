#!/bin/sh
# Runs on EVERY boot (unlike guac-appliance-firstboot.sh, which only runs
# once) — this is deliberate, not an oversight: the production Vault
# config (docker-compose.prod.yml, vault-config.hcl) uses file storage,
# not dev mode, which means Vault re-seals every time its container
# restarts (VM reboot, host maintenance, etc). Without this running on
# every boot, the appliance would come up with Vault sealed and the whole
# app broken until someone manually ran `vault operator unseal` — not
# an acceptable state for something meant to behave like an appliance.
#
# A genuine security design choice worth being explicit about rather than
# quietly deciding on the app's behalf: this generates a SINGLE unseal key
# (Shamir shares=1, threshold=1) rather than the multi-person/multi-share
# split Vault supports and which HashiCorp recommends for anything beyond
# a small, single-operator deployment. That's the right default for a
# self-contained appliance with no other infrastructure to distribute
# shares to, but it does mean anyone with access to
# /data/guac-appliance/vault-init-keys.txt can unseal Vault outright — the
# administrator is expected to retrieve that file, store it somewhere
# genuinely secure, and remove it from the appliance once confirmed safe.
# This script does not do that removal automatically, since destroying the
# only copy of the unseal key on a misconfigured backup workflow would be
# far worse than leaving the file in place a little too long.
set -e

VAULT_ADDR=http://127.0.0.1:8200 # published from the vault container — see docker-compose.prod.yml
KEYS_FILE=/data/guac-appliance/vault-init-keys.txt
ENV_FILE=/data/guac-appliance/.env
APPROLE_MARKER=/data/guac-appliance/.vault-approle-done

log() { echo "[guac-appliance-vault-setup] $*"; }

export VAULT_ADDR

# Wait for the Vault container's API to actually be reachable — it can
# take a few seconds after `docker compose up` before this succeeds, and
# there's no other synchronization point between this script and that
# container coming up.
for _ in $(seq 1 30); do
	if vault status >/dev/null 2>&1; then break; fi
	sleep 2
done

STATUS_JSON=$(vault status -format=json 2>/dev/null || echo '{}')
INITIALIZED=$(echo "$STATUS_JSON" | sed -n 's/.*"initialized": *\(true\|false\).*/\1/p')
SEALED=$(echo "$STATUS_JSON" | sed -n 's/.*"sealed": *\(true\|false\).*/\1/p')

if [ "$INITIALIZED" != "true" ]; then
	log "Vault has never been initialized — running operator init (single key share)."
	INIT_JSON=$(vault operator init -key-shares=1 -key-threshold=1 -format=json)
	UNSEAL_KEY=$(echo "$INIT_JSON" | sed -n 's/.*"unseal_keys_b64": *\["\([^"]*\)".*/\1/p')
	ROOT_TOKEN=$(echo "$INIT_JSON" | sed -n 's/.*"root_token": *"\([^"]*\)".*/\1/p')

	umask 077
	cat > "$KEYS_FILE" <<-EOF
	# Vault unseal key and initial root token for this appliance instance,
	# generated once at first Vault initialization. RETRIEVE THIS FILE AND
	# STORE IT SOMEWHERE SECURE (a password manager, an HSM, printed and
	# locked in a safe — whatever your organization's standard is for a
	# secret that unseals the credential vault for every connection this
	# appliance manages) — then consider removing it from this appliance
	# once you've confirmed you have it safely elsewhere.
	VAULT_UNSEAL_KEY=$UNSEAL_KEY
	VAULT_ROOT_TOKEN=$ROOT_TOKEN
	EOF
	log "Vault initialized. Unseal key and root token written to $KEYS_FILE — see the warning in that file."
fi

if [ "$SEALED" = "true" ] || [ "$INITIALIZED" != "true" ]; then
	if [ -f "$KEYS_FILE" ]; then
		UNSEAL_KEY=$(sed -n 's/^VAULT_UNSEAL_KEY=//p' "$KEYS_FILE")
		log "Unsealing Vault."
		vault operator unseal "$UNSEAL_KEY" >/dev/null
	else
		log "Vault is sealed and $KEYS_FILE is missing — cannot unseal automatically. Manual intervention required."
		exit 1
	fi
fi

if [ ! -f "$APPROLE_MARKER" ]; then
	log "Bootstrapping Transit engine + AppRole (same pattern as e2e/vault-init.sh, against this real production Vault)."
	ROOT_TOKEN=$(sed -n 's/^VAULT_ROOT_TOKEN=//p' "$KEYS_FILE")
	export VAULT_TOKEN="$ROOT_TOKEN"

	vault secrets enable -path=transit transit 2>/dev/null || true
	vault write -f transit/keys/guac-credentials 2>/dev/null || true
	vault auth enable approle 2>/dev/null || true

	vault policy write guac-app - <<-POLICY
	path "transit/encrypt/guac-credentials" { capabilities = ["update"] }
	path "transit/decrypt/guac-credentials" { capabilities = ["update"] }
	POLICY

	vault write auth/approle/role/guac-app \
		token_policies="guac-app" \
		token_ttl=1h \
		token_max_ttl=4h

	ROLE_ID=$(vault read -field=role_id auth/approle/role/guac-app/role-id)
	SECRET_ID=$(vault write -f -field=secret_id auth/approle/role/guac-app/secret-id)

	# Unlike e2e/vault-init.sh's fixed test values, these are genuinely
	# generated per-appliance-instance — real deployments, real secrets.
	sed -i "s|^VAULT_ROLE_ID=.*|VAULT_ROLE_ID=$ROLE_ID|" "$ENV_FILE"
	sed -i "s|^VAULT_SECRET_ID=.*|VAULT_SECRET_ID=$SECRET_ID|" "$ENV_FILE"

	touch "$APPROLE_MARKER"
	log "AppRole bootstrap complete. Restarting the backend so it picks up the new credentials."
	docker compose -f /opt/guac-access-suite/docker-compose.yml \
		-f /opt/guac-access-suite/docker-compose.appliance.yml \
		--env-file "$ENV_FILE" restart backend || true
fi

log "Vault setup check complete."
