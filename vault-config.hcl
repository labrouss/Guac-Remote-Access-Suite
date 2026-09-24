storage "file" {
  # /vault/file, not /vault/data — the official image's own
  # docker-entrypoint.sh only auto-chowns three specific hardcoded paths
  # for the non-root `vault` user the process actually runs as:
  # /vault/config, /vault/logs, and /vault/file (confirmed by reading that
  # real entrypoint script directly). /vault/data was a made-up path
  # outside all three, so its volume kept default (root) ownership and
  # Vault's own non-root process could never write to it — confirmed by a
  # live deployment: "failed to persist keyring: mkdir /vault/data/core:
  # permission denied" on the very first write attempt, at
  # initialization. Using /vault/file instead means the entrypoint's own
  # built-in chown logic handles this correctly with nothing further
  # needed on our end.
  path = "/vault/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  # Plain HTTP within the Docker network — Vault here is only ever reached
  # container-to-container (backend -> vault:8200), never exposed to the
  # host or the internet directly, so TLS at this layer isn't providing
  # protection against anything actually reachable. Previously this was
  # tls_disable = 0 with tls_cert_file/tls_key_file pointing at files that
  # were never actually generated or mounted anywhere — Vault would fail
  # to start at all (confirmed by a real docker compose up: "error loading
  # TLS cert: open /vault/config/vault-cert.pem: no such file or
  # directory"), a broken-out-of-the-box default this file shipped with.
  # If you're running this on a network you don't fully trust between the
  # backend and vault containers, put real certs in place and flip this
  # back to 0 with tls_cert_file/tls_key_file set, rather than relying on
  # Docker's network isolation alone.
  tls_disable = 1
}

# This same file is used by both docker-compose.prod.yml/dev.yml and the
# Buildroot appliance's production Vault (buildroot/board/guac-appliance/
# rootfs-overlay's guac-appliance-vault-setup.sh runs against it) — the fix
# above applies to both, they were both broken by the same missing certs.
ui = true
