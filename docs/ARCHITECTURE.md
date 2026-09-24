# Architecture Overview

## Components

- **frontend** — TypeScript SPA, connection panel (overlay, not push-layout),
  Guacamole session canvas, recording playback UI, theme system.
- **backend** — Express/TypeScript API: auth (password + TOTP), RBAC over
  connection lists/groups, guacamole-lite token issuance, Vault client,
  audit logging, first-time setup gate.
- **guac-worker** — background job runner (BullMQ/Redis) for video export
  (`guacenc`) and scheduled recording cleanup.
- **guacd** — stock Apache Guacamole daemon, protocol translation only.
  Treated as untrusted-boundary-adjacent: it holds no auth logic itself.
- **Vault** — Transit secrets engine, encryption-as-a-service for all
  connection credentials. The app never holds a raw encryption key.
- **Postgres** — all relational state: users, groups, connections,
  permissions, sessions, recordings, audit log.

## Key design decisions

1. **Auth lives entirely in the app, never in Guacamole.** Password + TOTP
   verified by the backend before a guacamole-lite token is ever issued.
   guacd never sees or handles authentication.

2. **Credential modes are per-connection**, not global: `shared` (one
   vaulted credential for whoever connects) or `individual` (each user
   supplies their own, enforced before connect is allowed).

3. **Session recording taps the instruction stream at the proxy layer**,
   not guacd's native `recording-path` parameter — this allows starting
   and stopping recording mid-session without a reconnect.

4. **SSH file transfer multiplexes an SFTP channel over the already-
   authenticated SSH connection** rather than opening a second connection,
   so a clipboard file paste never triggers a second auth prompt.

5. **The connection panel is an overlay, not a layout push** — the
   Guacamole canvas's pixel size never changes when the panel opens,
   avoiding a resize instruction to the remote session mid-use.

6. **Setup is a one-time, non-reversible gate** (`system_config.setup_completed`),
   checked by both a backend middleware and a frontend route guard, so the
   first-run wizard appears automatically and can't be re-triggered later.

See the inline comments in `migrations/` for the full schema, and
`backend/src/routes/setup.ts` for the setup wizard flow.
