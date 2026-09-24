# Guac Access Suite

Secure, RBAC-driven remote access to datacenter infrastructure (RDP/VNC/SSH) built on
Apache Guacamole, with vaulted per-user or shared credentials, session recording and
export, connection list sharing, live session sharing, admin-only ad-hoc
connections for one-off access without saving a reusable record, passkey
sign-in, drag-and-drop file transfer, touch input support, and a translatable UI
that a new language can be added to just by dropping a file in.

## Features

**Access**
- RDP, VNC, SSH, Telnet, and Kubernetes exec, via Apache Guacamole's `guacd`
- Per-user and per-group RBAC over shared connection lists
- A private per-user connection space — no admin setup required
- Admin-only [ad-hoc connections](#ad-hoc-connections) for one-off access without saving a reusable record
- [Proxied bookmarks](#proxied-bookmarks) for internal-only web hosts, alongside direct ones
- ["Demos"](#demos) — curated bundles of connections/bookmarks grantable independent of normal list permissions

**Security**
- Vaulted credentials (HashiCorp Vault, Transit engine) — shared per connection or set individually per user
- [Passkey](#passkeys) (WebAuthn) sign-in
- [Active Directory](#active-directory) login over LDAPS, with optional group-membership sync
- Full [audit logging](#audit-logging) with optional syslog forwarding
- [TLS](#tls) via optional Caddy overlays — public Let's Encrypt or on-demand internal certificates

**In a session**
- In-browser session recording, with optional MP4 export
- [Live session sharing](#live-session-sharing) — invite another user to co-view or co-control an already-open session in real time
- Bidirectional text clipboard sync
- [File transfer](#file-transfer) both directions — drag-and-drop upload, RDP drive redirection and SSH SFTP for download
- [Touch input](#mobile-and-touch-devices) support for phones and tablets
- [Working RDP audio](#audio) playback, with a manual Unmute fallback
- Multiple concurrent sessions, with tab switching and keyboard shortcuts

**Admin & operations**
- [Connections export/import](#connections-exportimport)
- [Backup and restore](#backup-and-restore)
- [Appliance image](#appliance-image-ova) (OVA / portable QEMU bundle)
- A translatable UI — a new [language](#languages) becomes available by dropping a file into a directory, no rebuild needed

## Quick start

**Building from a full source checkout** (this repo, cloned or unzipped
with `backend/`, `frontend/`, etc. all present) — the commands below
need one addition: add `-f docker-compose.dev.yml` before `up`, and use
`docker compose -f docker-compose.dev.yml up -d --build` specifically for
step 2. `docker-compose.yml`'s own `image:` lines point at pre-built
GHCR images that only exist after an official tagged release actually
runs `.github/workflows/release.yml` — there's nothing to pull yet from
a plain source checkout, and no `build:` directive on that file for
`--build` to act on either; `docker-compose.dev.yml` is the one file in
this repo with real `build:` blocks pointing at `backend/Dockerfile`,
`./frontend`, and `guac-worker/Dockerfile`. **Downloading an actual
tagged release** (a `.zip` from this project's Releases page, with no
source directories in it, only compose files and configs) needs no
flag at all — that bundle's own `docker-compose.yml` already has real,
resolvable image tags baked in by the release workflow.

1. Copy the environment template and fill in real secrets:
   ```bash
   cp .env.example .env
   ```
   Generate strong random values for `POSTGRES_PASSWORD`, `SESSION_SECRET`,
   `JWT_SECRET`, and `GUAC_TOKEN_ENCRYPTION_KEY` — any length works for the
   last one specifically (it's hashed into a real key internally), unlike
   an earlier version of this app where it genuinely needed to be exactly
   32 bytes and silently broke every connection otherwise.

2. Start the stack:
   ```bash
   docker compose up -d
   ```
   The `migrate` service applies all pending Postgres migrations before `backend`
   starts.

3. Initialize and unseal Vault, and bootstrap the credential-encryption
   AppRole the backend uses — a fresh Vault (file storage, not dev mode)
   comes up uninitialized and sealed by default, and nothing else in this
   stack does this step for you:
   ```bash
   ./scripts/vault-init.sh
   ```
   Retrieve `vault-init-keys.txt` (written by this script) and store it
   somewhere secure — see the warning in that file. **Re-run this same
   script any time Vault re-seals** (a host reboot, `docker compose
   restart`, anything that restarts the `vault` container) — it detects
   what's already done and only unseals, rather than re-initializing.

4. Open `https://your-host/` in a browser. On first run you'll land directly on the
   first-time setup wizard — no separate URL to know about. Setup covers:
   - Instance name + first administrator account
   - TOTP 2FA enrollment for that admin
   - Vault connectivity check
   - Default theme selection (Signal Dark, Daylight, Midnight, or Comic —
     each user can change their own later from the header)

   Once setup completes, the wizard becomes permanently unreachable and every
   subsequent visit resolves to the normal login page.

## Private vs. shared connections

Every user gets a personal "My Connections" list automatically when their
account is created — visible only to them, no admin setup required, and each
connection in it defaults to individual credentials (their own username/
password, vaulted separately from anyone else's). This is where a user's own
one-off boxes live.

Admins additionally create **shared** connection lists (`/admin` → Lists tab)
and grant access to specific users or groups at `view`/`connect`/`edit`/
`admin` levels. Connections inside a shared list can use either:
- **Individual credentials** — each user who connects supplies their own,
  stored separately per user.
- **Shared credentials** — one vaulted credential used by everyone with
  `connect` access on that connection.

Both personal and shared lists use the exact same underlying permission
model (`list_user_permissions` / `list_group_permissions`) — a personal
list's owner simply holds an implicit `admin` grant on it from creation.

## Ad-hoc connections

Administrators can also connect directly — fill in a hostname, port, and
credentials in a "Quick connect" dialog and connect immediately, with
nothing saved as a reusable connection record at all. Useful for a genuine
one-off: a box that isn't going to be reconnected to again, or a quick
check before deciding whether it's worth adding as a real connection.

This is deliberately admin-only, enforced server-side independent of the
UI: every other connection in this app is reachable only because an admin
explicitly granted it through the list-based permission model above, and
an ad-hoc connection has no saved record to check permissions against at
all. Admins already have this same reach today, through the slower path of
first saving a real connection — this doesn't grant new access, only a
faster way to use access that already exists. Credentials typed into the
dialog are never written to `connection_credentials` or Vault; they exist
only long enough to be folded into one short-lived, encrypted connection
token. Recording, live sharing, and RDP/SSH file transfer are not
available for this kind of session, since those all depend on a saved
connection record to key their own lookups by — the connection itself
still works fully.

## Live session sharing

A session's owner can invite another user to co-view or co-control it,
live, in real time — via the **Share** button in the session toolbar
(only shown to the session's own owner, not someone who joined it). Pick
a user and whether they get **viewer** (watch only) or **interactive**
(their own mouse/keyboard input is forwarded too) access.

The invited person sees it either passively — a "Shared with you" entry
in the Sessions menu — or proactively, as a dismissable toast with a
one-click Join, the moment it's shared. Joining doesn't open a second,
separate connection to the remote host; everyone sees the exact same
live display guacd is already sending the owner.

Revoking access ends that person's connection immediately, not just the
grant — they don't get to keep watching until they happen to close their
own tab. The owner's own connection closing ends the shared session for
everyone, the same way it would for a lone session.

## Languages

The UI can be translated, and a new language becomes available by
dropping a file into the `locales/` directory — no rebuild, no code
change, no restart. Ships with English (`en.json`), Greek (`el.json`),
German (`de.json`), French (`fr.json`), and Italian (`it.json`) as
real, working examples — five, not one plus a proof of concept. See
`locales/README.md` for the exact
contribution workflow, and `techdetails.md` Section 12 for which parts of
the UI currently pull their text from these files — this is a deliberate,
partial first slice, not a claim that the whole app is translated yet.

If you're running via `docker compose`, `./locales` on the host is bind-
mounted into the backend container — a file dropped there is picked up
immediately, since the backend reads the directory fresh on every request
rather than caching it. If you've customized the compose file or are
running the backend some other way, make sure whatever directory the
backend reads from (`GET /api/locales`) is the one you're actually editing.

## Proxied bookmarks

A bookmark can be marked **proxied** instead of **direct**. Direct bookmarks
open straight in a new tab, same as any browser bookmark. Proxied bookmarks
are for internal-only hosts the user's browser can't reach but the backend
container can (e.g. an isolated management VLAN) — the backend reverse-
proxies the target through `/proxy/:bookmarkId`, authenticated by a
path-scoped cookie rather than a header, since a `window.open()` navigation
can't carry an `Authorization` header.

The proxy rewrites `Location` redirects, `Set-Cookie` paths (so a login flow
doesn't loop forever — see `techdetails.md` Section 10 for why an unscoped
cookie path causes exactly that), and absolute/protocol-relative URLs baked
into a target's own HTML/JS/CSS response bodies, all back into the
`/proxy/:bookmarkId` prefix. It also accepts self-signed certificates on the
target (the target is always something an admin explicitly configured into
a bookmark, not arbitrary user input, so this is a deliberate trust
decision, not a blanket weakening) and strips the target's own
`Content-Security-Policy` header, since one written for the target's real
origin would otherwise block the target's own scripts from running under
the proxy's rewritten path. Still not a universal solution for every app —
a target that *constructs* its own URLs at runtime (reading
`window.location` rather than a literal string already in its source) has
no text for a response-body rewrite to ever find. See
`backend/src/routes/bookmarkProxy.ts` for the exact rewriting it does and
doesn't do.

## Demos

A **demo** (e.g. `veeamdemo`) is a named, curated set of existing connections
and bookmarks — pulled from wherever they normally live — that you can hand
to a specific person for a presentation, without giving them any access to
the underlying connection lists themselves.

- Any user can create a demo. Adding an item to it requires you to already
  have at least `view` access to that item's own list — you can't curate a
  demo out of things you can't see yourself.
- Granting another user access to a demo gives them exactly the items in
  that demo, nothing more. It's a completely separate grant from
  `list_user_permissions`/`list_group_permissions` — someone can view and
  use a demo's connections and bookmarks with zero access to the parent
  lists those items came from.
- Demo access only ever reaches `connect`-level for connections and
  `view`-level for bookmarks — never enough to edit or delete the
  underlying item, no matter what permission the demo owner themselves has.

## What's in this bundle

| Path                  | Purpose                                                        |
|-----------------------|-----------------------------------------------------------------|
| `docker-compose.yml`  | Full stack: backend, frontend, guacd, guac-worker, Postgres, Vault, Redis |
| `.env.example`        | Every secret/config value the stack needs                       |
| `migrations/`         | Ordered SQL migrations, applied automatically on startup         |
| `locales/`            | UI translation files, one per language — see "Languages" below   |
| `docs/`               | Architecture notes                                               |
| `VERSION`             | Plain-text version string of this build                         |
| `version.json`        | Version + commit + exact image tags for this build               |
| `CHECKSUMS.sha256`    | Checksums of every file in this bundle                           |

## Security notes

- Credentials are never stored in plaintext — Vault's Transit secrets engine
  handles encrypt/decrypt, and Postgres only ever holds ciphertext.
- Session recordings are stored in Guacamole's native instruction-stream format
  (`.guac`) for lossless, instantly-seekable playback, with optional MP4 export
  via `guacenc` for sharing outside the app.
- All administrative and access actions are written to the `audit_log` table.

See `techdetails.md` for a full technical wrap-up (architecture, request
flow, data model, testing status), and `docs/` for the short-form
architecture writeup.

## Verification status

See `TODO.md` for the current, actively-maintained list of what's been
genuinely verified with real tools versus what's still an open gap —
kept there specifically so it never goes stale the way a static snapshot
in this file would. `docs/TESTING_PLAN.md` has the prioritized plan for
closing the remaining test-coverage gaps.

## TLS

By default, the frontend container serves plain HTTP (`8443:8080` in
`docker-compose.prod.yml`) — you're expected to put TLS termination in front
of it, same as you would for any internal tool. This matters beyond general
good practice: [passkeys](#passkeys) specifically require a secure (HTTPS)
connection to work at all — see that section for what actually breaks
without one.

Two optional Caddy overlays cover the two real deployment shapes, so you
don't need your own reverse proxy or manual certificate handling for
either one:

**No public domain — the common case for this app's own primary use
case** (internal remote access to datacenter infrastructure, reached by
an internal hostname or a bare IP, not a public FQDN):

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy-internal.yml up -d
```

No `DOMAIN` to set for this one — Caddy mints its own, locally-trusted
certificate on demand (`tls internal` — a real, standard Caddy feature,
not a workaround) for whichever hostname or IP address a request
actually arrives on, the first time it's used, automatically. This
isn't just a convenience: an earlier version of this overlay needed
`DOMAIN` set to one specific, fixed value, and reaching it any other
way — a bare IP in one browser tab, an internal DNS name in another,
both genuinely valid ways to reach the same box — failed outright with
a browser "can't establish a secure connection" error, not a
certificate warning. That's fixed now, structurally: any hostname or IP
that actually reaches this container gets its own valid certificate
automatically, with nothing to configure and nothing to get out of
sync.

Browsers will still show a private-connection warning to click through
on first visit, since the certificate isn't from a publicly-trusted CA
— but the connection is still genuinely encrypted, which is all
passkeys themselves actually require. For a clean, no-warning
experience across every device that connects, import Caddy's own root
CA into each one's trust store once:

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy-internal.yml \
  cp caddy:/data/caddy/pki/authorities/local/root.crt ./guac-internal-ca.crt
```

— then install `guac-internal-ca.crt` as a trusted root on whichever
devices need it (this varies by OS; search "install trusted root
certificate" for yours). Optional polish, not required for passkeys to
start working.

**A real public domain**, for a quick, zero-maintenance option with a
publicly-trusted certificate:

```bash
# .env: set DOMAIN=guac.example.com
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Handles automatic Let's Encrypt certificate issuance and renewal. This
requires ports 80 and 443 reachable from the internet (80 for the ACME
HTTP-01 challenge) and a DNS record pointing at this host — for a
deployment with no public DNS at all, use the internal overlay above
instead, or your own internal CA / reverse proxy; Caddy's automatic
Let's Encrypt mode specifically assumes a publicly resolvable domain and
will not work without one.

See `Caddyfile` / `Caddyfile.internal` for the exact config either way.

The internal overlay's own certificate lifetime is deliberately raised
well above Caddy's own 12h default (see `Caddyfile.internal` itself for
the full reasoning) — a real, reported case of connections breaking
outright about a day in, needing a full restart to recover, traced
directly to that short a default leaving too little margin for Caddy's
own background renewal to reliably land in time.

**Why these stay separate overlay files, not merged into
`docker-compose.prod.yml`/`.dev.yml`/`.test.yml` directly**: Caddy's own
`DOMAIN` requirement is enforced with Compose's `${DOMAIN:?...}`
syntax, which fails the *entire* file at startup if unset — confirmed
directly (not assumed) that this fires even for a service gated behind
a Compose `profiles:` entry, since env var interpolation happens before
profile filtering. Baking Caddy into the base files would force
everyone to set `DOMAIN` just to run the plain-HTTP default, whether
they want Caddy or not. Kept as its own file instead, `DOMAIN` is only
ever evaluated when that file is actually requested — confirmed the
same way: the base file alone parses cleanly with no `DOMAIN` set at
all, and only the overlay's own inclusion triggers the check.

If typing two `-f` flags every time is the friction, Compose's own
`COMPOSE_FILE` environment variable avoids it without merging anything:
set `COMPOSE_FILE=docker-compose.yml:docker-compose.caddy.yml` in
`.env`, and a bare `docker compose up -d` picks up both automatically.

## File transfer

**Local → remote**: drag a file from your own computer and drop it
anywhere in the session window — it uploads automatically. SSH pushes it
over SFTP; RDP drops it straight into that session's own drive-
redirection folder.

**Remote → local, RDP only**: inside the Windows session, a "Guacamole
Transfer" network drive is available. Save or drag a file into it, and
once the copy has genuinely finished, it's offered as a normal browser
download — no special action needed beyond that.

**Remote → local, SSH**: not currently available — SSH has no equivalent
of RDP's own virtual drive; see `TODO.md` for the closest realistic
option (watching a well-known remote folder over SFTP, the same way the
RDP drive already works).

There is no true clipboard-triggered file sync for any protocol — Ctrl+C
on a file inside a remote session does not make it appear locally, for
RDP, VNC, or SSH alike. This isn't a gap in this app specifically; Apache
Guacamole's own architecture treats file transfer as a separate mechanism
from the text clipboard entirely, for every protocol it supports.

## Mobile and touch devices

A phone or tablet's screen works the same as a laptop trackpad: drag your
finger to move the cursor, tap to click, and long-press or two-finger tap
for a right-click, the same touchpad-style gestures Guacamole's own web
app itself uses. A mouse and a touchscreen both work at once on the same
device, so nothing needs to be switched or configured either way.

## Audio

RDP sessions play remote audio automatically, the same as any other
Guacamole deployment — this isn't a Guacamole limitation to work around.
Browsers themselves keep audio playback silenced until you've actually
interacted with the page at least once, so the first click or tap inside
a session resumes it automatically. If a session's audio still seems
silent, the **Unmute** button next to Share forces this directly, and
also shows whether the browser currently considers audio active.

If it's still silent after that, and the remote machine is a VM, check
first whether it actually has a virtual sound device at all — many
hypervisors, ESXi/vSphere included, don't add one by default, and
without it Windows has nothing to generate sound with in the first
place, regardless of any RDP or Guacamole setting. Otherwise, the most
likely cause is the remote Windows session's own audio-redirection
setting rather than anything on this app's side.

## Troubleshooting

**Connections fail with the browser console showing `WebSocket
connection ... failed`, or (on an older checkout) a connection just sits
on "connecting" forever with no error at all.** This was the actual root
cause of connection failures in early versions of this app (fixed as of
this version). `nginx.conf` never had a route for the Guacamole
WebSocket tunnel itself — only `/api/` and `/proxy/` were proxied to the
backend. The tunnel connected to bare `/`, which only ever matched the
SPA's own static-file fallback (`try_files ... /index.html`), so nginx
served `index.html` in response to what should have been a WebSocket
upgrade — the browser correctly reports this as an immediate connection
failure. Fixed by giving the tunnel its own dedicated path: the frontend
now connects to `/tunnel`, and `nginx.conf` has an explicit
WebSocket-upgrade-aware `location /tunnel` block matching the same
pattern already used for `/api/` and `/proxy/`. If you're on an older
checkout, either upgrade or add that location block yourself (see
`frontend/nginx.conf` in this version) and rebuild the frontend image —
a `.env` change alone won't fix this one, it needs the new frontend
build.

**`GUAC_TOKEN_ENCRYPTION_KEY` needed to be *exactly* 32 bytes, silently.**
A separate, real bug (also fixed as of this version): `guacamole-lite`'s
own token decryption failed outright ("Invalid key length") for any
other length, silently from the browser's perspective. Confirmed
directly: this repo's own `.env.example` placeholder was 36 bytes, not
32. Fixed by hashing the raw key (SHA-256) into a guaranteed-32-byte key
internally, on both the encrypt and decrypt sides — any length works
now, this can't recur. Worth knowing this and the WebSocket routing
issue above were two independent, real bugs found in the same
diagnostic session — fixing only one of them wouldn't have been enough
on its own.

**Vault crash-looping with "address already in use" on port 8200.** This
was a real bug in this repo's own compose files (fixed as of this
version, described here for anyone who hits it on an older checkout): the
`vault` service's `command:` used to be `server
-config=/vault/config/vault-config.hcl`, but the official
`hashicorp/vault` image's own entrypoint script *automatically* adds
`-config=/vault/config` (the whole directory) whenever the command starts
with `server` — so the explicit flag made Vault's actual command line
specify `-config` twice, and it tried to bind the same listener from both.
If you're on a version with this fix, `command: server` is correct as-is
(the entrypoint's own automatic behavior already picks up the
volume-mounted `vault-config.hcl`) — don't add a `-config=...` flag back.
A useful diagnostic if something like this ever recurs: run Vault as a
one-off container bypassing the entrypoint
(`docker compose run --rm --entrypoint sh vault -c "vault server
-config=/vault/config/vault-config.hcl"`) — if that starts cleanly but the
normal managed container doesn't, the entrypoint's own argument handling
is the first thing worth checking, not the config file itself.

**"Invalid code" on login, or a 500 with `Vault decrypt failed` in the
backend logs, even though TOTP enrollment worked fine during setup.**
This means the admin account's stored TOTP secret is no longer
decryptable — almost always because Vault got re-initialized with a new
Transit key at some point after the secret was originally encrypted (a
volume got wiped, `vault-init.sh` ran against a Vault that looked
uninitialized again, etc.). A new key means the old ciphertext can never
be recovered — this is how Vault's Transit engine is supposed to work,
not a bug to fix by retrying. Since `setup_completed` is otherwise
correctly permanent once true, this used to be a genuine dead end with no
recovery path through the app at all. Run
`./scripts/reset-setup-lockout.sh` (read its own header first — it's a
security-sensitive operation, since it briefly reopens the setup wizard)
to reopen setup, then sign back in with the same username: this app's own
setup flow treats that as *resuming* an interrupted setup and lets you
re-enroll a fresh TOTP secret against the current Vault instance, rather
than erroring.

## Appliance image (OVA)

For deployment as a self-contained VM appliance (vSphere/ESXi) rather than
`docker compose` on an existing host, see `buildroot/README.md` — a
Buildroot-based Linux image that boots straight into the full stack,
packaged as a `.ova`. **Not yet built or verified** — see that README's
"Verification status" section before relying on it.

## Connections export/import

Any list's own connections (not the list's permissions, not other
lists) can be exported to a JSON file and re-imported — from that
list's own admin view, "Export connections" / "Import connections".
This is a different, narrower thing than the full-stack backup/restore
scripts below: a quick way to move or duplicate a specific list's
connection definitions (host, port, protocol, which folder), not a
disaster-recovery tool for the whole deployment.

By default, credentials are never included — a connection's own
username/password is Vault-encrypted specifically so it's never
available in plaintext outside Vault, and a plain export respects that.
Restoring one re-creates the connection definitions; credentials need
to be re-entered afterward, the same as setting a connection up fresh.

Checking "Include credentials (encrypted)" includes each connection's
own actual credential in the export too — still genuinely encrypted,
never as plaintext: the exact same Vault ciphertext already stored in
the database is carried through as an opaque string, decrypted only
when actually used, the same as it always is. Which credential that is
depends on the connection: a shared connection's own shared credential,
or — for an individual one — only *your own* credential for it, never
anyone else's; a connection whose credential is another user's own is
simply skipped, not included with the wrong owner attached. This only
works when re-imported into the *same* installation (Vault's own
encryption keys are specific to that Vault instance) — importing it
somewhere else restores the connections fine, but their credentials
won't decrypt there. Requires admin-level access on the list, the same
bar as setting a shared credential directly.

## Backup and restore

`scripts/` has standalone shell scripts for Postgres, Vault, and session
recordings — none needs anything beyond a running `docker compose` stack
and Docker itself:

```bash
./scripts/backup-all.sh                    # all three, to ./backups/
./scripts/backup-postgres.sh                # just Postgres
./scripts/backup-vault.sh                   # just Vault
./scripts/backup-recordings.sh              # just recordings

./scripts/restore-postgres.sh ./backups/postgres-20260101T020000Z.sql.gz
./scripts/restore-vault.sh ./backups/vault-20260101T020000Z.tar.gz
./scripts/restore-recordings.sh ./backups/recordings-20260101T020000Z.tar.gz
```

All three restore scripts require typing a confirmation phrase back
before doing anything destructive. The Vault restore additionally
requires the `vault` service to be stopped first (restoring into a live
process would corrupt its on-disk state), and needs the original unseal
key(s) to bring the restored instance back up — the backup itself is
Vault's own encrypted data-at-rest, not a substitute for having those
keys stored separately. The recordings restore similarly requires
`backend` and `guac-worker` to both be stopped first.

Postgres and recordings are two separate backups covering two separate
halves of the same data — a recording's own metadata (who made it, when,
which connection) lives in Postgres; the actual recording file lives in
the recordings volume. Restoring one without the other from around the
same time leaves either a file with no matching database row (invisible
in the app) or a database row with no matching file (visible, but fails
to play) — restore both together after any real disaster.

Point cron at `backup-all.sh` for scheduled backups — see the comment at
the top of that script for an example crontab line. Backups default to
`./backups/`, which is gitignored; move them somewhere durable (off this
host) for them to actually protect against host loss.

## Passkeys

Sign in with your device's own fingerprint, face recognition, or PIN
instead of a password and authenticator code — the same "usernameless"
experience Google and other major sites offer. From the header's own
username menu, register one per device you use; a passkey is
inherently multi-factor on its own (the device is "something you have,"
its unlock is "something you are/know"), so signing in with one skips a
separate two-factor step entirely, even on accounts that also have
authenticator-app 2FA enabled.

**Requires HTTPS** (or `localhost` specifically) — a real browser
requirement of the passkey standard itself, not something this app can
work around. This app's own default `docker-compose.prod.yml` serves
plain HTTP (see the "Security hardening" section below on putting a
TLS-terminating reverse proxy in front of it); reached that way, by a
real hostname or IP rather than literally `localhost`, the Passkeys page
will say plainly that it needs a secure connection rather than
(misleadingly) that the browser itself doesn't support passkeys — it's
the connection, not the browser, and setting up TLS in front is what
actually fixes it.

**`PUBLIC_URL` must exactly match how you actually reach this app in
your browser** — this is a second, separate requirement from HTTPS
itself, and easy to miss if TLS gets added to a deployment sometime
after it was first set up over plain HTTP. Confirmed by a real
deployment hitting exactly this: every passkey registration and
sign-in failing outright ("Could not verify this passkey." / "That
passkey could not be used to sign in.") after switching to Caddy,
because `PUBLIC_URL` in `.env` still said `http://` (or an entirely
different hostname) from before. Passkeys derive their own identity
(the "RP ID") from this value at backend startup — update it to match
the real `https://` address you use, then restart the `backend`
container (it's read once at startup, not per request). With the
self-signed, on-demand overlay specifically — which can serve valid
HTTPS for several different hostnames/IPs to the same instance at once
— pick whichever one you'll consistently sign in from and set
`PUBLIC_URL` to exactly that; a passkey registered under one hostname
won't validate under a different one, by design of the WebAuthn
standard itself, not a limitation here.

**Safari/iCloud Keychain may show a passkey's "site" as just the
parent domain** (e.g. `example.com`) even when it was created for a
specific subdomain (`app.example.com`) — this is Safari's own display
grouping, confirmed behavior for exactly this shape of setup, not a
sign that the passkey was actually created for the wrong host: this
app's backend checks the *exact* origin on every registration and
sign-in, not just the domain, so a passkey that registered and signed
in successfully is correctly tied to the specific address it was
created for regardless of the simplified label Safari's own UI shows
for it.

## Active Directory

Optional, off by default — set every one of `AD_URL`, `AD_BASE_DN`,
`AD_BIND_DN`, `AD_BIND_PASSWORD`, and `AD_REQUIRED_GROUP_DN` in `.env`
to turn it on (see `.env.example`'s own comments for each). Once
enabled:

- Any AD account that's a member of the one group named by
  `AD_REQUIRED_GROUP_DN` can sign in with their AD username and
  password, on the same login page as everyone else — no separate URL
  or button to find.
- An AD account is created here automatically on its first successful
  login (the same personal "My Connections" list any new account
  gets), not something an admin has to set up ahead of time for every
  future member of that group.
- **AD group membership can be synced into this app's own groups**,
  optionally and separately from the group that gates login itself —
  set `AD_GROUP_MAPPINGS` in `.env` to a JSON array of AD-group-DN to
  local-group-name pairs. This is a genuine, ongoing sync, re-checked
  on every login, not a one-time grant at account creation: losing
  membership in a mapped AD group removes the corresponding local
  group membership on that person's next login too. It only ever
  touches memberships it granted itself, though — a group an admin
  assigns by hand through the ordinary admin panel is never affected by
  this, even for an AD account, and even if the group's name happens to
  match one of the configured mappings. Left unset, AD login still
  works fine, but an account is never placed into any of this app's own
  groups automatically — every account's access is assigned by hand
  instead, the exact same way as for a locally-created one; this was
  this app's own original behavior for every AD account before this was
  added, not a fallback bolted on afterward.
- **If a mapping isn't taking effect for a real account**, check it
  directly rather than guessing: `docker compose exec backend npm run
  check-ad-group-sync -- someusername` — shows this container's own
  current `AD_GROUP_MAPPINGS`, and that user's real, live AD group
  membership compared against it. The single most common cause: a
  value only just added to `.env` never reaching an already-running
  container (`docker compose restart` reuses its existing environment
  as-is — `docker compose up -d --force-recreate backend` actually
  picks it up); the tool also catches a DN that doesn't exactly match
  what AD itself reports (a different OU, a typo).
- This app's own 2FA (TOTP or a passkey) is asked for after a
  successful AD login under exactly the same condition as for a local
  account: only if that particular account has it turned on for
  itself. There's no separate policy to configure for this — an AD
  account can enable either one for itself, self-service, from the
  header's own user menu, at any time, the same way a local account
  can.
- A connection can optionally be set to **AD passthrough** instead of
  a shared or individual stored credential — the signed-in user's own
  AD username and password (captured once, at login, kept
  Vault-encrypted the same way a stored credential is) are used
  directly for that RDP/SSH session, with nothing to configure or
  store against the connection itself at all. Set from the connection
  form's own credential-mode dropdown, only ever shown as an option
  once AD is actually turned on. If a signed-in user tries to open one
  of these and nothing usable is currently on file for them (AD not
  enabled for their account's own login, or simply expired), it fails
  clearly rather than silently falling back to some other credential.
- Requires LDAPS (`ldaps://`, not `ldap://`) — a plaintext LDAP bind
  would send the service account's own password, and every user's own
  AD password on every login attempt, over the network unencrypted,
  which this app's own security posture elsewhere (Vault-encrypted
  stored credentials, HTTPS required for passkeys) doesn't make an
  exception for here. If login fails with an error containing
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (check `docker compose logs
  backend` — a failed AD login logs the real reason there, see below),
  that's expected for a real AD environment, not a misconfiguration: a
  domain controller's LDAPS certificate is normally issued by that
  organization's own internal CA, which Node.js doesn't trust by
  default. Fix by dropping that CA's certificate into `./ca-certs/`
  and setting `NODE_EXTRA_CA_CERTS` in `.env` — see that directory's
  own `README.md` for the full steps (including how to verify it
  actually worked, and a real gotcha worth knowing up front: export the
  certificate from the CA server itself, not a client machine's own
  trust store, which can hold a stale, superseded copy).
- Verify the certificate setup directly rather than only finding out
  through a failed login: `docker compose exec backend npm run
  check-ad-cert` — runs a real TLS connection to `AD_URL` and a real
  cryptographic check against `NODE_EXTRA_CA_CERTS`, reporting exactly
  which of the problems above (if any) is the actual cause, developed
  from and matching a real, reported troubleshooting session.
- A failed AD login logs its specific reason (wrong password vs. not
  in the required group vs. an LDAP connectivity/config problem, etc.)
  to the admin-only audit log — the browser itself only ever sees a
  generic "invalid credentials," the same as a wrong local password,
  so this doesn't leak anything to whoever's actually at the login
  form. A connectivity/config problem specifically (an unreachable
  `AD_URL`, wrong `AD_BIND_DN`/password, or the certificate issue
  above) also logs to the backend's own console.
- An admin disabling an account (the existing "disable" action in the
  Users tab) takes effect immediately for an AD account too, including
  clearing anything currently on file for AD passthrough use — not
  left to wait out its own separate expiry.

## Security hardening

- **Rate limiting**: `/api/auth/login` and `/api/auth/login/totp` (10
  attempts/15 min per IP), the bookmark proxy (session issuance and proxy
  traffic), and a general 300 req/min-per-IP ceiling across the rest of
  `/api`.
- **CSRF protection**: the setup wizard (the one flow authenticated by a
  cookie rather than a Bearer token) uses a double-submit CSRF token —
  every other route's Bearer-token scheme already isn't vulnerable to
  classic CSRF, since a cross-site page can't attach an Authorization
  header to a forged request.
- **Idle session timeout**: a session's token is refreshed on every
  request while genuine mouse/keyboard/touch activity continues
  (`SESSION_IDLE_TIMEOUT_MINUTES`, default 30) — a tab left open with
  nothing but background polling happening doesn't count as activity and
  times out on schedule regardless — capped by an absolute session
  length regardless of activity (`SESSION_ABSOLUTE_MAX_HOURS`, default
  12, matching this app's previous fixed session length). Both
  configurable in `.env`.

## Audit logging

Every mutating action in the app — logins and failed login attempts,
credential writes, admin actions (user/group/list creation, permission
grants/revokes, connection changes), demo access grants, file transfers,
session connects, recording start/stop — is written to the `audit_log`
table via a single centralized service (`backend/src/services/auditLog.ts`),
including the request's source IP.

Admins can browse and filter the log in the admin panel's **Audit Log**
tab, or directly via `GET /api/admin/audit-log` (filterable by user, action
type, connection, and date range).

### Remove vs. Disable

Disabling an account (the users list's own **Disable** button) is fully
reversible — the row, and everything tied to it, stays exactly as it
was; the account just can't log in again until **Enable** undoes it.

**Remove** is a real, separate, irreversible deletion — added directly
in response to disable alone not actually freeing up a username or
taking an account out of the users list at all. Two things it
deliberately does *not* touch, on purpose:

- **Audit history is kept, not deleted.** The account's own past audit
  log entries survive with their username preserved (so the record of
  who did what doesn't go anonymous), just no longer linked to a live
  account.
- **A shared list this person happened to own survives too**, becoming
  ownerless rather than disappearing — other people's access to it
  isn't affected by removing whoever created it. Only their own private
  personal list is actually deleted along with the account.

Two safety checks Remove has that Disable doesn't, since Remove can't
be undone: you can't remove your own account, and you can't remove the
last remaining Administrator.

One limitation worth knowing, not specific to Remove: this app issues
stateless JWTs, and `requireAuth` verifies a token's own signature and
expiry only — it never re-checks the database on every request. An
account with an already-issued, still-unexpired token keeps
authenticating for up to its own session's absolute-max lifetime after
being removed (or disabled — this affects both equally), even though
most routes' own separate permission checks would fail for it in
practice. Actually closing this would mean adding server-side session
tracking, a bigger, separate decision, not something folded in here.

### Forwarding to syslog

Set `SYSLOG_ENABLED=true` in `.env` to also forward every audit event as an
RFC 5424 message to an external syslog server (a SIEM, `rsyslog`,
`syslog-ng`, etc.):

```bash
SYSLOG_ENABLED=true
SYSLOG_HOST=your-syslog-server.example.com
SYSLOG_PORT=514
SYSLOG_PROTOCOL=udp   # or tcp, or tls for an encrypted connection
SYSLOG_FACILITY=16    # RFC 5424 facility code; 16 = local0
```

Postgres remains the durable record regardless — syslog forwarding is
fire-and-forget (UDP by default) and never blocks or fails a request if the
syslog server is unreachable. Use `tls` instead of `udp`/`tcp` if the syslog
server isn't on a trusted local network, since UDP/TCP syslog traffic is
unencrypted and unauthenticated by default.
