#!/bin/sh
# Bootstraps the throwaway dev-mode Vault instance in docker-compose.test.yml
# so the app's AppRole login (VAULT_ROLE_ID/VAULT_SECRET_ID in e2e/.env.test)
# actually works. Dev-mode Vault auto-unseals but starts with nothing else
# configured — no Transit engine, no AppRole auth method, no role.
#
# DRAFTED, UNVERIFIED. Run as a one-shot init container against the vault
# service before backend starts (see the vault-init service in
# docker-compose.test.yml).
set -eu

export VAULT_ADDR="${VAULT_ADDR:-http://vault:8200}"
export VAULT_TOKEN="${VAULT_DEV_ROOT_TOKEN_ID:-e2e-dev-root-token}"

echo "Waiting for Vault to be reachable..."
until vault status >/dev/null 2>&1; do sleep 1; done

echo "Enabling Transit secrets engine..."
vault secrets enable -path=transit transit 2>/dev/null || echo "(already enabled)"
vault write -f transit/keys/guac-credentials 2>/dev/null || echo "(key already exists)"

echo "Enabling AppRole auth method..."
vault auth enable approle 2>/dev/null || echo "(already enabled)"

echo "Writing the app's policy and role..."
vault policy write guac-app - <<POLICY
path "transit/encrypt/guac-credentials" { capabilities = ["update"] }
path "transit/decrypt/guac-credentials" { capabilities = ["update"] }
POLICY

vault write auth/approle/role/guac-app \
  role_id="e2e-fixed-role-id-for-testing-only" \
  token_policies="guac-app" \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_bound_cidrs="" \
  bind_secret_id=true

# Passing role_id explicitly above (rather than letting Vault generate one)
# is what makes this fully reproducible with a static e2e/.env.test — same
# reasoning as custom-secret-id below. Without it, e2e/.env.test's
# VAULT_ROLE_ID would need to be read back out of Vault at runtime instead
# of being a fixed value known ahead of time.
echo "role_id fixed to: e2e-fixed-role-id-for-testing-only"

# custom-secret-id lets us supply a fixed, known secret_id rather than
# accepting Vault's own randomly-generated one — this is what makes the
# whole bootstrap reproducible with a static e2e/.env.test rather than
# needing the backend container to read a dynamically-generated value at
# startup. Without this, ordinary `secret-id` generation would produce a
# different value every run and there would be no way for a static .env
# file to have the right one.
vault write auth/approle/role/guac-app/custom-secret-id \
  secret_id="e2e-fixed-secret-id-for-testing-only"

echo "Vault bootstrap complete. role_id and secret_id are both fixed by"
echo "construction (not read back from Vault), matching e2e/.env.test."
