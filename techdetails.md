# Guac Access Suite — Technical Wrap-Up

A single reference for what this system is, how each piece works, and why
it's built the way it is. `docs/ARCHITECTURE.md` is the short version;
`TODO.md` and `docs/TESTING_PLAN.md` track what's open. This document ties
the whole thing together.

---

## 1. What this is

A self-hosted, browser-based remote access platform for datacenter
infrastructure — RDP, VNC, SSH, Telnet, and Kubernetes exec — built on
Apache Guacamole's `guacd` protocol daemon, with the actual authentication,
authorization, credential vaulting, session recording, and audit logging
all owned by a custom Express/TypeScript backend rather than Guacamole's
own Java webapp. `guacd` is treated purely as a protocol-translation
engine; it never makes an authorization decision.

Core capabilities: per-user and per-group RBAC over shared connection
lists, a private per-user connection space with no admin setup required,
vaulted credentials (shared-per-connection or individual-per-user),
in-browser session recording with optional MP4 export, live session
sharing — inviting another user to co-view or co-control an already-open
session in real time (Section 8) — admin-only ad-hoc connections for
connecting directly without saving a reusable record (Section 3), a
translatable UI where a new language becomes available by dropping a file
into a directory at runtime (Section 12), drag-and-drop file transfer in
both directions plus RDP drive redirection and SSH SFTP-backed transfer
(Section 6), touch input support for phones and tablets, working RDP
audio playback with a manual fallback control, bookmark management
(including a reverse proxy for internal-only hosts), "demos" — curated
bundles of connections/bookmarks grantable to a user independent of their
normal list permissions — full audit logging with optional syslog
forwarding, and a first-time setup wizard that gates the entire app until
an admin account exists.

---

## 2. System components

| Component | Role |
|---|---|
| **frontend** (`frontend/`) | React/TypeScript SPA. Login, setup wizard, connection panel, session viewport, admin panel, demo panel. |
| **backend** (`backend/`) | Express/TypeScript API. Owns auth, RBAC, the guacd tunnel, credential encryption calls, audit logging, the bookmark reverse proxy. |
| **guac-worker** (`guac-worker/`) | Separate Node process. BullMQ-driven video export (`guacenc`) and scheduled recording-retention cleanup. |
| **guacd** | Stock `guacamole/guacd` image. Protocol translation only — RDP/VNC/SSH/Telnet/Kubernetes to the Guacamole wire protocol. |
| **Postgres** | All relational state — see Section 4. |
| **Vault** | HashiCorp Vault, Transit secrets engine. Encryption-as-a-service for every stored credential; the app never holds a raw encryption key, only ciphertext. |
| **Redis** | BullMQ's queue backend for `guac-worker`. |

Three Docker Compose files exist for three different purposes:
`docker-compose.dev.yml` (builds from source), `docker-compose.prod.yml`
(pulls prebuilt images — what ships in the release zip), and
`docker-compose.test.yml` (a throwaway e2e stack with dev-mode Vault and a
disposable SSH target). An optional `docker-compose.caddy.yml` overlay adds
automatic Let's Encrypt TLS.

---

## 3. Request flow: how a connection actually gets established

This is the piece most worth understanding end-to-end, since it's where
every security decision in the app converges.

1. **Frontend requests a tunnel token.** `POST /api/tunnel-token/:connectionId`
   (`backend/src/routes/tunnelToken.ts`), authenticated by a Bearer JWT.
   `issueNewConnectionToken` does all the real work right here, synchronously,
   before returning anything at all — not a lightweight token resolved
   later at WebSocket-connect time:
   - Checks `hasConnectionAccess(userId, connectionId, 'connect')`, which
     itself checks either an ordinary list permission (`view` / `connect` /
     `edit` / `admin` via `list_user_permissions` / `list_group_permissions`)
     or a demo grant (`demo_access`, Section 7).
   - Looks up the connection's `credential_mode`. For `individual`, queries
     `connection_credentials` scoped to `(connection_id, user_id)`. For
     `shared`, scoped to `(connection_id, NULL)`. Getting this NULL-vs-userId
     branching wrong is exactly the kind of bug that would either lock
     everyone out or leak one user's credential to everyone else — it's the
     single most heavily unit-tested piece of logic in the codebase (see
     `guacTunnel.test.ts` and `credentials.test.ts`).
   - Calls `decryptCredential()` (to Vault Transit) to turn the stored
     ciphertext into the actual username/password guacd needs.
   - For RDP specifically, generates a per-session drive-redirection folder
     (Section 6) and injects `enable-drive`/`drive-path` into the connection
     params.
   - Builds one AES-256-CBC-encrypted token (`encryptGuacToken`) containing
     the *fully resolved* connection: `{ userId, connectionId, rdpDriveId,
     issuedAt, connection: { type, settings: { hostname, port, username,
     password, ...params } } }`. This token, not a lookup key, is what the
     frontend actually receives — everything guacd needs to connect is
     already inside it.
   - The route handler itself (not `issueNewConnectionToken`) then writes
     an audit log entry (`action: 'connect'`) via the centralized audit
     service (Section 9) before responding — still at this token-issuance
     step, not deferred to WebSocket-connect time.

2. **Frontend opens the guacd tunnel.** `SessionViewport.tsx` opens a
   `Guacamole.WebSocketTunnel` carrying that token. `guacamole-lite`
   (mounted in `backend/src/services/guacTunnel.ts`) decrypts it and hands
   the payload to `passThroughConnectionSettings` — deliberately *not* a
   second round of database/Vault work. It checks only `issuedAt` against
   `TOKEN_MAX_AGE_MS` (the token could be minutes old; this bounds how
   stale a still-valid-looking token can be) and passes the already-resolved
   settings straight through. The re-check that matters for
   permissions-may-have-changed-since-issuance defense in depth already
   happened in step 1 — this step is intentionally synchronous and cheap.
   Only now does guacd receive real connection settings — hostname, port,
   protocol, decrypted username/password.

3. **guacd connects to the real target** and the Guacamole protocol stream
   starts flowing back through the WebSocket to the browser canvas.

The credential itself is decrypted exactly once, in-memory, at token-issuance
time, and is never logged, never sent back out separately from the encrypted
token itself, and never persisted outside Vault's own ciphertext.

### Ad-hoc connections: the same flow, minus the database entirely

`issueAdhocConnectionToken` (same file) is the admin-only sibling of
`issueNewConnectionToken` — "Quick connect" in the UI, for filling in
connection details directly and connecting immediately without ever saving
a reusable connection record. It builds the identical shape of token
(`connection: { type, settings: {...} }`), through the identical
`passThroughConnectionSettings` path on the WebSocket side — but every
value in it comes straight from the request body instead of a database
row: no `connections` lookup, no `hasConnectionAccess` check (there's no
saved connection to check permissions against at all — the gate here is
`isAdministrator`, checked directly, independent of anything list-based),
no `connection_credentials` query, no Vault call. `connectionId` is `null`
throughout the resulting token and the session it opens — every downstream
consumer of that field (`guacTunnel.ts`'s own `'open'` handler chief among
them) treats a null `connectionId` as "no saved connection to look anything
up from," which is also why Record, Share, and RDP file-transfer polling
are all deliberately unavailable for this kind of session (see Section 12
and `SessionViewport.tsx`'s own `adhocSettings` prop comment) — those all
depend on a real, saved `connectionId` to key their own lookups by.
`POST /api/tunnel-token/adhoc` is registered before the `/:connectionId`
route it sits alongside, deliberately — Express matches routes in
registration order, and that wildcard would otherwise swallow "adhoc" as
if it were a literal connection id.

---

## 4. Data model

19 migrations (`migrations/001` through `019`), roughly grouped:

- **Identity**: `users`, `groups`, `user_groups`. A seeded `Administrators`
  group is relied on by name in `setup.ts` and `admin.ts` — protected from
  deletion in the admin API.
- **Connections & permissions**: `connection_lists` (a list can be
  `is_personal` — auto-provisioned per user, see Section 5 — or shared),
  `connections`, `connection_folders` (migration 018 — real, standalone
  folder entities with `view`-level visibility matching their connections',
  not just a free-text label; migration 017's earlier `connections.folder`
  text column was superseded by this, not kept alongside it),
  `list_user_permissions` / `list_group_permissions` (both ranked
  `view < connect < edit < admin`), `connection_credentials` (Vault
  ciphertext only, keyed by `(connection_id, user_id | NULL)`).
- **Sessions & audit**: `sessions` (`connection_id` nullable since
  migration 016 — both a saved connection's own history surviving its
  deletion, and an ad-hoc session, which never had one at all, rely on
  this), `session_participants` (the join/leave event ledger — who
  actually connected and when, distinct from grants), `session_shares`
  (migration 015 — the grants themselves: who's allowed to join a specific
  active session, checked independently of any list permission, since a
  shared session is a one-off grant to *this specific live session*, not
  standing access to the connection behind it; see Section 8),
  `session_recordings` (both the raw `.guac` file and an optional exported
  `.m4v` path, `connection_id` nullable for the same reason as `sessions`
  above), `audit_log` (Section 9).
- **Bookmarks, demos**: `bookmarks` (with `access_mode: direct | proxied`
  and `enable_websocket`, Section 10) and `bookmark_folders` (migration
  019, the identical pattern `connection_folders` established one
  migration earlier), `demos` / `demo_items` / `demo_access` (Section 7).
- **System**: `system_config` (the single-row `setup_completed` gate,
  Section 5).

**A note on `themes` (migration 004) — present in the schema, unused by the
running app.** This table (system/user-created themes as JSON token blobs,
plus a `users.active_theme_id` foreign key) was an earlier design for
theming that the app never actually queries anywhere — `grep`ing the whole
backend for `FROM themes` or `active_theme_id` turns up nothing. The real,
current theme system (Signal Dark, Daylight, Midnight, Comic) is entirely
frontend: one CSS file per theme under `frontend/src/themes/`, each
defining the same fixed set of 13 CSS custom properties under
`[data-theme='id']`, selected client-side and persisted to `localStorage`
(`themes/registry.ts`) — nothing server-side involved at all, `themes` and
`active_theme_id` included. Left as-is rather than dropped as part of a
documentation pass — a schema change is a different kind of risk than
correcting what a doc says about it, and worth doing deliberately, not as
a side effect of fixing this file.

Every migration file has inline comments explaining why a given constraint
or index exists — that's the fastest way to understand a specific table's
intent.

---

## 5. Auth, setup, and the two cookie-based flows

Everything except two specific flows uses Bearer JWTs, not cookies —
issued by `POST /api/auth/login` (password), then
`POST /api/auth/login/totp` (TOTP challenge, via `otplib`). Both
endpoints are rate-limited (10 attempts/15 min per IP). A generic
`invalid_credentials` error is returned whether the username doesn't
exist or the password is wrong, to avoid a user-enumeration signal.

**Session lifetime — idle timeout with an absolute cap
(`services/sessionToken.ts`, `middleware/requireAuth.ts`).** Requested
directly, replacing what had been a flat, non-renewing 12h JWT expiry
with no idle concept at all. `requireAuth` now refreshes the token
(sliding window, `SESSION_IDLE_TIMEOUT_MINUTES`, default 30) on every
request that reaches it, returned via an `X-Refreshed-Session-Token`
response header — but a `loginAt` claim, carried through unchanged on
every refresh rather than reset, lets a separate check
(`hasExceededAbsoluteMax`) enforce `SESSION_ABSOLUTE_MAX_HOURS` (default
12, preserving this app's own previous fixed session length as a
ceiling rather than losing it) regardless of how continuously active a
session has been. `requireAuth.test.ts` covers this directly with a
token whose own idle-window `exp` is still comfortably valid but whose
`loginAt` has passed the absolute max, confirming the two checks are
genuinely independent, not the same check twice.

The refresh alone would be insufficient on its own: this app already
polls in the background while a tab is open (`ShareNotifications.tsx`,
every 10s), and a design where *any* successful request extends the
session would make "idle" meaningless as long as a tab stays open at
all, regardless of whether anyone is actually there. The fix lives
client-side (`lib/activityTracker.ts`, `lib/authFetchInterceptor.ts`):
genuine mouse/keyboard/touch activity is tracked separately from network
activity, and a refreshed token is only actually stored if there's been
real activity within the last 90 seconds — otherwise it's discarded, and
the already-stored, earlier-issued token keeps counting down to its own
real expiry no matter how many background requests keep succeeding in
the meantime. `activityTracker.ts` listens in the *capturing* phase
specifically: `SessionViewport.tsx`'s own comment documents that
`Guacamole.Keyboard` attaches its own listener to `document` globally
(the same target), and `Guacamole.Mouse` attaches to the session's own
display element, a descendant of `document` — a capturing-phase
listener runs before the event ever reaches that descendant at all, so
it's never at risk of missing activity during an actively-used remote
session to some downstream `stopPropagation()`, confirmed as the actual
reason for that choice rather than assumed. A separate periodic check
(`startIdleExpiryWatcher`) decodes the stored token's own `exp` claim
directly and redirects proactively once it's passed, rather than
waiting for whatever background call happens to hit a 401 next.

That decode step needed its own real-environment verification: `atob()`
expects standard base64 (`+`/`/`, padded to a multiple of 4), while a
JWT's own base64url encoding uses `-`/`_` and is never padded — a first
draft translated the character set but not the padding, and a real
browser's `atob()` (unlike Node's far more lenient `Buffer.from`, which
the first draft was accidentally verified against and appeared to pass)
throws outright on unpadded input rather than decoding it wrong. Caught
and fixed by testing against `jsdom`'s own real `atob()` implementation
specifically, with a payload engineered to guarantee `-`/`_` characters
in its encoded form rather than hoping a random one would happen to
contain them.

The refreshed-token response header needed one more fix to actually be
usable: `app.ts`'s `cors()` config explicitly whitelists which response
headers cross-origin JavaScript may read at all (`exposedHeaders`) —
the exact same class of bug already documented on that same line for
`Content-Disposition` would have applied equally to this new header,
silently returning `null` to `response.headers.get(...)` in a genuinely
cross-origin setup (e.g. local dev with Vite's dev server on a different
port) had it not been added to that list too.

The two exceptions:

1. **The setup wizard** (`backend/src/routes/setup.ts`) uses
   `express-session`, since it's a multi-step, stateful flow with no user
   account to issue a JWT for yet (`setupUserId`/`pendingTotpSecret` live
   in the session between steps). Because this is the one cookie-based
   flow with real state-changing side effects, it's the one place with
   CSRF protection (`services/csrf.ts`) — a double-submit token issued
   alongside `GET /api/setup/status` and required as an `X-CSRF-Token`
   header on every mutating step. `GET /api/setup/status` also gates the
   entire frontend: `App.tsx` checks it before rendering anything, and once
   `setup_completed` flips to true, every `/api/setup/*` route permanently
   404/410s — there's no way to re-trigger the wizard.

2. **Proxied bookmarks** (`guac_proxy_session`, Section 9) — deliberately
   not CSRF-protected, and that's a considered decision, not an oversight:
   the cookie authorizes a transparent reverse proxy to a third-party
   destination, and adding app-level CSRF semantics there would mean
   rejecting the destination's own legitimate forms/AJAX calls as if
   forged. The cookie is instead scoped narrowly (one bookmark's path
   prefix, short-lived, permission-rechecked on every request).

Every account gets exactly one personal connection list
(`provisionPersonalList`, `services/userProvisioning.ts`) the moment it's
created — during setup for the first admin, or via `POST /api/admin/users`
for everyone after. This list gets an explicit `admin`-level
`list_user_permissions` row for its owner; there's no special-casing for
personal lists elsewhere in the permission logic, which keeps
`getEffectiveListPermission` a single, uniform code path for both personal
and shared lists.

**Passkeys (`services/webauthn.ts`, migration 020) — requested directly
("like Google and some sites do").** Wraps `@simplewebauthn/server`
(v14; its exact current API shape was confirmed by reading the installed
package's own type definitions before writing anything against it,
rather than assumed from memory of an earlier version — this library's
function signatures have changed across majors). `RP_ID`/`ORIGIN` are
derived from `PUBLIC_URL` (already required for other reasons — see
that variable's own comment in `.env.example`) rather than a separate
config value, so there's one source of truth for "what domain is this
app on."

Login (`POST /api/auth/passkey/options` + `/verify`, both pre-auth,
rate-limited like the password step) is deliberately usernameless:
`generatePasskeyAuthenticationOptions` passes no `allowCredentials` at
all, so the authenticator itself surfaces whichever passkeys it holds
for this origin without anyone typing a username first — which real
user that turns out to be is only known once the response comes back
with a specific credential id in it, which `verifyPasskeyAuthentication`
looks up. A successful passkey login issues a full session token
directly, skipping a separate TOTP challenge entirely even on accounts
that also have TOTP enabled — a passkey is inherently multi-factor on
its own (the device is "something you have," its own unlock is
"something you are/know"), the same way Google and other sites treat a
passkey as a complete sign-in rather than an alternative first factor
still needing a second one stacked on top.

Registration and login both wrap their challenge in a short-lived
(60s) JWT handed back to the client and returned again alongside the
actual WebAuthn response (`registrationToken`/`authToken`) — the same
stateless-round-trip shape `me.ts`'s existing TOTP enroll/verify pair
already established, for the identical reason (no session cookie
reliably round-trips on this Bearer-only API). That token's job is
giving the challenge a server-side TTL and, for registration
specifically, binding it to `req.userId` (checked against the token's
own `sub` on verify, not trusted from the token alone) — it is not what
secures the ceremony itself; the actual cryptographic guarantee is the
authenticator's own signature over the challenge, which
`verifyRegistrationResponse`/`verifyAuthenticationResponse` re-derive
and check independently regardless of what the wrapper token claims.

Management (`GET/DELETE /api/me/passkeys`, `POST .../register-options`
+ `.../register-verify`) lets an account register more than one passkey
(a laptop, a phone, a security key) and name each one, mirroring
`connection_folders`/`bookmark_folders`'s own one-to-many-table
reasoning rather than a column. `webauthn_credentials` is a genuinely
new table, not the `users.webauthn_credentials` JSONB column present
since this app's very first migration (001) — that column had zero
code anywhere ever reading or writing it, an early placeholder for this
exact feature that was never carried through, and dropped here rather
than reused: a usernameless login's primary lookup is "which user does
this credential id belong to," which a JSONB array on `users` would
need a containment scan across every user's own array to answer, where
a dedicated table with `credential_id UNIQUE` and indexed answers it
with one indexed lookup — confirmed by running all 20 migrations in
sequence against a real, local Postgres instance, not just the syntax
inspected.

A real bug caught before shipping, worth naming for what class of
mistake it was: an early draft of the passkey-removal audit log call
passed the removed row's own id as `logAuditFromRequest`'s fourth
positional argument — which is specifically `connectionId`, a real
foreign key to `connections(id)` (migration 003), not a generic
related-entity id. That would have failed the foreign key constraint
outright on every single passkey removal, the exact same class of bug
this project already hit once before for connection deletion itself
(migration 016's own history). Fixed by putting the passkey's id in the
audit `detail` JSONB field instead, where it belongs.

**Secure-context reporting (`lib/webauthn.ts`'s `isSecureContext`) — a
real user report, not a design choice made up front.** WebAuthn itself
is only ever exposed by the browser in a secure context (HTTPS, or
`localhost` specifically — a real, "Baseline Widely Available since
2018" web platform restriction, confirmed directly rather than assumed,
since this app's own default `docker-compose.prod.yml` deliberately
serves plain HTTP and expects a TLS-terminating proxy in front — see
that file's own comment). `@simplewebauthn/browser`'s own
`browserSupportsWebAuthn()` can't distinguish "this browser genuinely
lacks passkeys" from "this connection isn't secure enough for the
browser to offer them here" — both return the identical `false` from
its one boolean check — so someone on a fully modern browser, reached
over plain HTTP by a real hostname rather than literally `localhost`,
was shown "this browser doesn't support passkeys," a plausible-sounding
but wrong and unfixable-as-stated explanation for what's actually a
one-line reverse-proxy problem. `isSecureContext()` (a thin wrapper
around the standard `window.isSecureContext`) is checked first, and
`PasskeySettingsPage.tsx` shows the accurate, actionable explanation for
whichever of the two real cases actually applies.

**`PUBLIC_URL` mismatch — a second, separate real deployment failure,
reported after the one above was already fixed.** `RP_ID`/`ORIGIN` in
`services/webauthn.ts` are derived from `PUBLIC_URL`, computed once at
module load, not re-evaluated per request. A real deployment enabled
HTTPS (the self-signed, on-demand overlay, Section 14) sometime after
initial setup, without also updating `PUBLIC_URL` from its original
`http://` value to match — every registration and authentication then
failed outright (`verifyRegistrationResponse`/`verifyAuthenticationResponse`
returning `verified: false`), surfacing as the generic "Could not
verify this passkey." / "That passkey could not be used to sign in."
messages `me.ts`/`auth.ts` already had for this path, not a new failure
mode. Confirmed by tracing both messages directly to those two
verification calls before concluding this was the cause, not assumed
from the symptom alone. `.env.example`'s own `PUBLIC_URL` comment
previously only explained its role for the setup wizard's CSRF cookie
— extended to name this second, independent dependency explicitly,
since nothing about finishing initial setup successfully would have
hinted this same value needed revisiting later. Worth noting
specifically for the on-demand internal overlay: it can serve valid
HTTPS for several different hostnames/IPs to the same instance at
once, but a passkey's own RP ID is still a single, fixed value — an
account has to consistently use whichever one hostname `PUBLIC_URL`
was set to, by design of the WebAuthn standard itself, not a
limitation introduced here.

One more real question from the same deployment, worth recording since
it looks alarming but isn't: Safari's own Passwords UI showed the
registered passkey's "site" as the bare parent domain rather than the
specific subdomain `PUBLIC_URL` was set to. Confirmed as a known Safari
/ iCloud Keychain display-grouping behavior (documented directly by
Apple's own community forum for the identical shape of setup —
multiple subdomains of one company domain, credentials shown grouped
under the parent) rather than an actual RP ID mismatch: this app's own
`expectedOrigin` check in `verifyRegistrationResponse`/
`verifyAuthenticationResponse` requires the *exact* origin, not just a
suffix match, so a credential that registered and signed in
successfully is provably tied to the specific host it was created for,
regardless of what Safari's own UI simplifies it to for display.

---

## 6. RDP drive redirection & SSH file transfer

Both exist to make moving a file into or out of a session feel like a
normal, direct action rather than a separate upload/download step.

**Local → remote** (both protocols): drag a file from the local computer
and drop it anywhere in the session window. RDP writes it straight into
that session's own drive-redirection folder; SSH pushes it over SFTP
using the same vaulted credential the terminal session itself is using —
a second, separate protocol-level connection rather than true
multiplexing on guacd's own already-authenticated SSH socket (guacd owns
that connection, not this backend process, so true multiplexing isn't
currently possible without deeper guacd integration); the user-facing
result is identical either way, since no second visible auth prompt is
ever shown. (A clipboard-paste path exists too, but is only ever capable of handling
an image explicitly copied from a web page's own "Copy image" action —
the browser's Async Clipboard API has no way to read a real file copied
from the OS's own file manager at all, confirmed directly against
multiple browser vendors' own documentation; drag-and-drop is the one
real, general mechanism for an actual file.) The uploaded file's own real
name is used — not a generic placeholder — threaded through from the
dropped `File` object's own `.name`, falling back to a MIME-derived name
only for the clipboard-image path, which never had a real filename to
begin with. Real upload progress comes from `XMLHttpRequest`'s own
`upload.onprogress` (`fetch` has no equivalent). A 413 (file over the
configured size limit — multer's own limit, matched by `nginx.conf`'s
`client_max_body_size` right alongside it) surfaces as a specific,
readable message rather than a bare status code.

**Remote → local, RDP only** (`services/rdpDriveManager.ts`): every RDP
connection auto-mounts a per-session host folder into the guacd
connection params (`enable-drive`/`drive-path`) — no toggle, always on.
Saving or dragging a file into that drive from inside the Windows session
surfaces it as a downloadable-file notification in the frontend
(`SessionViewport.tsx` polls `GET /api/sessions/:id/rdp-downloads`),
clicked to trigger a real, authenticated download (`fetch()` with the
real bearer token, then a local blob URL — a plain `<a href>` link can
never carry a custom header at all, which is why one doesn't work here).
The download itself shows real, live progress the same way the upload
side does, reading the response body as a stream and tallying bytes
against its own `Content-Length`; a second click on an already-downloading
entry is a no-op rather than firing a second, overlapping request.

The drive watcher (`fs.watch()` on that per-session folder) has to
distinguish a real file the person actually put there from Windows' own
background noise — confirmed directly from a real `guacd` log, Windows
(or FreeRDP's own drive-redirection layer) probes for a few specific
names on a freshly-mounted network drive (`desktop.ini`, a bare
`Download`) that are never actually written, only ever refused ("File
open refused") — and, for a large file specifically, from treating each
of several real, separate, genuine write events during one still-ongoing
copy as a new file rather than the same one settling. Three real,
distinct defenses, layered rather than any one alone: a 3-second grace
period after the drive is first mounted (covers Windows' own
just-connected initialization activity generally); a case-insensitive
name filter for the two specific probed names actually seen; and,
the one that actually, generally closes the false-positive class
regardless of name, requiring a path to genuinely, currently exist as a
real file (`fs.existsSync` + `.isFile()`) before ever surfacing it at
all — a refused probe never leaves anything real behind either way. The
large-file-duplicate-notice problem is solved separately, with a
per-filename debounce: each new write event for a given file cancels and
restarts a short (1.5s) settle timer specific to that file, and only once
that timer elapses without being reset again — genuinely no further
writes in the interim — is the file treated as finished and surfaced,
once. The folder itself is created at connect and torn down at
disconnect, its own in-flight settle timers cleared alongside it.

**Remote → local, SSH**: not currently available — SSH has no equivalent
of RDP's own virtual drive; see `TODO.md` for the closest realistic
option (watching a well-known remote folder over SFTP, the same way the
RDP drive already works).

There is no true clipboard-triggered file sync for any protocol — Ctrl+C
on a file inside a remote session does not make it appear locally, for
RDP, VNC, or SSH alike. This isn't a gap in this app specifically; Apache
Guacamole's own architecture treats file transfer as a separate mechanism
from the text clipboard entirely, for every protocol it supports.

---

## 7. Demos: access independent of list permissions

A demo (`demos` / `demo_items` / `demo_access`) is a named, curated bundle
of specific connections and bookmarks — e.g. `veeamdemo` — that can be
granted to a user with zero relationship to that user's actual list
permissions. This is the mechanism for handing a presales engineer or a
customer exactly a demo's worth of access without touching the real RBAC
on the underlying infrastructure lists.

Any authenticated user can create a demo (it's a personal curation tool,
not an admin-only feature) but can only add an item they themselves have
at least `view` on — you can't curate a demo out of things you can't see.
`getResolvedDemoView` (`routes/demos.ts`) is the function that actually
decides what a viewer sees: the owner always passes (short-circuiting the
grant lookup entirely); everyone else needs a live `demo_access` row,
checked with an expiry clause evaluated by Postgres's own `now()`, not
Node's clock — worth remembering if you ever try to test expiry with
`vi.useFakeTimers()`, which has no effect on the database server's own
time. Deleted-item references (a connection removed from its list after
being added to a demo) are silently filtered out of the resolved view
rather than erroring the whole demo.

---

## 8. Live session sharing: co-viewing/co-controlling in real time

A live session can be shared with another user directly — they watch or
control the exact same active session at the same time, not a separate
connection to the same host. This uses guacd's own protocol-level `join`
mechanism (a second client attaching to an already-open guacd connection),
via `guacamole-lite`'s support for it.

**This feature required upgrading `guacamole-lite` from `^0.6.0` to
`^1.2.0`** (0.6.x predates join support entirely), and that upgrade
surfaced three real, independently-serious bugs — found by testing directly
against the installed package's source rather than trusting its
documentation or changelog prose:

1. **The app's token encryption format didn't match what 1.2.0 actually
   decrypts.** The previous format omitted an outer base64 wrapping around
   the final `{iv, value}` JSON object that `guacamole-lite`'s own
   `Crypt.decrypt()` requires. Confirmed by round-tripping a real token
   through the installed package's actual decrypt function: it failed
   outright. Every connection would have broken immediately after the
   version bump, unrelated to session sharing. Fixed in a new
   `services/guacToken.ts`, which replicates `Crypt.js`'s exact algorithm
   (byte for byte, including the binary/latin1 intermediate encoding step)
   rather than importing from the package's internal, non-public-API file
   path.
2. **`sessions.guacd_connection_id` was storing the wrong ID.**
   `clientConnection.connectionId` (guacamole-lite's own internal
   per-websocket counter) was being stored where
   `clientConnection.guacamoleConnectionId` (the real guacd-assigned ID,
   the only one usable as a `join` target) belongs. Every previously-stored
   value in that column would have been useless for its stated purpose.
3. **The one that mattered most**: `guacamole-lite` constructs its
   `GuacdClient` from a *synchronous snapshot* of connection settings taken
   before the `processConnectionSettings` callback's async work (real
   `await` calls to Postgres/Vault, like this app's) can possibly resolve.
   Proved this empirically with a targeted test harness driving the real
   installed `ClientConnection` class directly (not a guess from reading
   source) — a callback that does genuine async I/O before calling back
   has no effect on what guacd actually receives; the connection proceeds
   with whatever was in the token *before* any authorization or credential
   decryption ran. Placing real authorization logic there — which is
   exactly how this app worked before this fix — provides no actual
   protection against a forged or stale token once guacd is actually
   involved.

**The fix**: move all authorization, credential decryption, and RDP drive
setup out of the `guacamole-lite` callback entirely and into the
token-issuance HTTP routes, which are properly async/await-safe. The
resulting token already carries a fully-resolved `connection` object
(protocol, hostname, decrypted username/password, or a `join` target) by
the time `guacamole-lite` ever sees it.
`services/guacTunnel.ts`'s `processConnectionSettings` callback is now a
trivial, deliberately synchronous pass-through — the only check it keeps is
a token-freshness comparison (`issuedAt` vs. now), since that requires no
I/O and so doesn't share the same race.

**How it actually works, end to end:**

1. **Granting**: `POST /api/sessions/:sessionId/share` (owner-only) inserts
   a row into `session_shares` — `role` is `viewer` or `interactive`. This
   is a grant tied to one specific *active* session instance, not a
   standing permission for future sessions on the same connection (it
   cascades away with the session row). Independent of the grantee's own
   list/connect permission on the underlying connection — same philosophy
   as demos. `DELETE /api/sessions/:sessionId/share/:userId` (revoking)
   deletes that grant and also calls
   `disconnectJoinedUser(sessionId, userId)` directly (see step 4 below):
   revoking access now actually ends that person's live connection at the
   same moment, rather than only removing the grant and leaving an
   already-open connection running until they happened to close the tab
   themselves.
2. **Discovering**: `GET /api/sessions/shared-with-me` lists active
   sessions someone has shared with the caller — surfaced two ways in the
   frontend: passively in `SessionMenu`'s "Shared with you" dropdown
   (fetched once, on open), and proactively —
   `ShareNotifications.tsx` polls this same endpoint every 10s and shows a
   dismissable toast with a one-click Join for any session it hasn't
   already surfaced. The first poll after mount deliberately establishes a
   baseline rather than toasting it — only a session id appearing in a
   *later* poll, having not been in the previous one, counts as newly
   shared; naively toasting everything the endpoint ever returns would
   announce a whole backlog of pre-existing shares the moment the app
   loads.
3. **Joining**: `POST /api/sessions/:sessionId/join-token`
   (`routes/sessions.ts`'s `issueJoinToken`) checks the caller is either
   the owner or has a `session_shares` row, then embeds
   `{ connection: { join: <the real guacd_connection_id>, settings:
   {'read-only': ...} } }` directly into the token — no protocol, hostname,
   or credentials needed, since it's joining an already-authenticated
   session rather than opening a new one.
4. **guacTunnel.ts's `open` handler** branches on whether the connecting
   token carries a `joinSessionId`: a join inserts a row into
   `session_participants` (the join/leave ledger) against the *existing*
   session row — no new `sessions` row, no new `SessionRecorder` (a
   joiner's own `guacdClient` is a separate protocol stream from guacd's
   perspective, but mirrors the same remote display the owner already
   sees, including screen changes driven by an interactive joiner's own
   input — tapping it separately for recording would just duplicate the
   same recording, not capture anything additional), and
   tracks the joiner's own live `clientConnection` in a new
   `activeJoinedConnections` map (`sessionId → userId → clientConnection`)
   keyed for exactly this purpose. **The owner's connection closing is
   what actually ends the shared session for everyone** — but this is no
   longer left to guacd's own cross-client teardown alone: an earlier
   version of this code assumed guacd reliably drops every joined client
   along with the primary connection on its own, and that assumption was
   reported live as not holding in practice (a joined participant's
   session was observed remaining open after the owner ended theirs).
   `disconnectAllJoined(sessionId)` now explicitly closes every currently
   tracked joined connection itself — confirmed directly, against
   `guacamole-lite`'s own real installed source, that calling `.close()`
   on a tracked `clientConnection` correctly tears down both its guacd-side
   connection and its WebSocket, and correctly re-emits through the same
   `'close'` event path this file already listens on, so the existing
   `session_participants.left_at` bookkeeping (every still-open row, not
   just the owner's own) needed no changes to stay correct alongside it.
5. **Frontend**: `SessionViewport.tsx` takes an optional `joinSessionId` +
   `readOnly` prop pair; when set, it fetches a join token instead of a
   new-connection token, and — regardless of `isActive` — never forwards
   keyboard/mouse input if `readOnly` is true. `ShareSessionButton.tsx`
   (owner-only, next to Record) grants/revokes shares via `UserPicker`;
   `SessionMenu.tsx` surfaces what's been shared with the current user
   passively, `ShareNotifications.tsx` does so proactively.

**A second, unrelated bug found while building this**: the frontend was
passing the *connection* ID to the Record button where the backend's
`/:sessionId/record` route expects the actual `sessions.id` — a different
UUID space entirely — meaning that route had almost certainly been
returning 404 silently ever since it shipped. Fixed by having
`SessionViewport` learn the real session ID after connecting
(`GET /api/sessions/:connectionId/active`, for new connections; already
known upfront for joins) and reporting it up via an `onSessionReady`
callback, which `MainApp.tsx` now uses to wire both Record and Share to
the correct ID.

**A known limitation, not solved here**: `guacamole-lite`'s
`sessionRegistry` callback (needed for joining across two different
backend containers behind a load balancer) isn't configured — the default
in-memory `Map` is correct for this app's default single-backend-replica
deployment, but horizontal scaling of the `backend` service would need a
shared registry (e.g. Redis-backed) instead.

---

## 9. Audit logging & syslog forwarding

Every mutating action across the app — logins and failed attempts,
credential writes, admin actions (user/group/list/connection/permission
changes), demo creation/items/access grants, bookmark CRUD/imports, file
transfers, session connects, recording start/stop — funnels through one
function: `logAudit()` / `logAuditFromRequest()` (`services/auditLog.ts`).
This was a real gap closed mid-project: an audit of the codebase at the
time found only about 2 of roughly 30 mutating routes had any audit entry,
and `source_ip` — a column since the very first migration — had never once
been populated. `app.ts` now sets `trust proxy` (nginx sets `X-Real-IP`)
so `req.ip` is the actual client, not the reverse proxy.

`logAudit()` always writes to Postgres first (the durable record), then
only if `SYSLOG_ENABLED=true` formats an RFC 5424 message
(`services/syslogForwarder.ts`, zero external dependencies by design) and
sends it over UDP (fire-and-forget, never blocks or fails a request), TCP,
or TLS. Admins browse the log via `GET /api/admin/audit-log` (filterable
by user/action/connection/date-range, paginated) and a frontend "Audit
Log" tab in `AdminPanel.tsx`, which uses the same `UserPicker` component as
permission/demo-access grants for real server-side username search.

---

## 10. Bookmarks: direct vs. proxied

A bookmark is either:
- **`direct`** — opens straight in a new tab (`window.open`, no `opener`
  leak back to the app).
- **`proxied`** — for an internal-only host the user's browser can't reach
  but the backend container's network can. Clicking it does a same-tab
  `fetch` to `POST /api/bookmarks/:id/proxy-session` first, which sets an
  HttpOnly cookie scoped to `/proxy/:bookmarkId` specifically (not the
  whole app) — necessary because a `window.open()` tab has no
  `Authorization` header to carry. The new tab then hits
  `routes/bookmarkProxy.ts`, which re-verifies the cookie and permissions,
  then reverse-proxies via `http-proxy-middleware`.

Four real, independently-reported issues shaped this route into its
current form, in the order they actually surfaced live:

1. **The proxy-session cookie was hardcoded `secure: true`.** Correct for
   the HTTPS-via-reverse-proxy deployment this project's own
   `docker-compose.prod.yml` recommends, but a browser will never store or
   send a `secure` cookie over plain HTTP at all — for a deployment
   genuinely running without TLS in front, the cookie was silently,
   permanently rejected every time, and proxied bookmarks could never have
   worked at all there. Fixed by deriving `secure` from the actual
   request's own scheme (`req.secure`, made reliable behind a reverse
   proxy by `app.set('trust proxy', 1)` in `app.ts`) instead of a hardcoded
   value.
2. **The target's own `Content-Security-Policy` header was forwarded
   unmodified.** A modern management UI's CSP is written for its own real
   origin and URL structure; under this proxy's rewritten
   `/proxy/:bookmarkId/` path, a reasonably strict one silently blocks
   exactly the scripts that would render the page's actual content —
   connects fine, shows nothing. Stripped (`Content-Security-Policy` and
   `Content-Security-Policy-Report-Only`) rather than rewritten — correctly
   rewriting an arbitrary target's CSP for a moved path is a much harder
   problem than the security value it would preserve here justifies, since
   the browser's own same-origin policy and this proxy's own cookie-based
   auth already gate access to the content regardless.
3. **Absolute and protocol-relative URLs inside a target's own response
   body were never rewritten.** `selfHandleResponse: true` plus
   `http-proxy-middleware`'s own `responseInterceptor` now finds every
   literal occurrence of the target's own origin in text-based response
   bodies (HTML/CSS/JS/plain text; binary content untouched) and rewrites
   it to the proxy's own `/proxy/:bookmarkId` path — a target that
   hardcodes its own address (`https://internal-host/app.js`) no longer
   sends the browser around the proxy entirely. Genuinely closes this gap
   rather than just documenting around it; still not a universal fix — a
   target that *constructs* its own URLs at runtime from `window.location`
   rather than a literal string in the source has no text for a
   response-body rewrite to ever find in the first place.
4. **`Set-Cookie` responses with no explicit `Path` (or the target's own,
   equally meaningless one) caused login redirect loops.** Per RFC 6265, a
   cookie with no `Path` defaults to the directory of the request that set
   it — a login response at `.../login/auth` setting a session cookie with
   no `Path` would default to something like `/proxy/:bookmarkId/login/`,
   so the browser would never send it back for the rest of the app under
   `/proxy/:bookmarkId/` generally. The target then never sees its own
   session cookie on the next request, concludes the user isn't
   authenticated, and redirects to login again — forever. Every
   `Set-Cookie`'s `Path` is now rewritten to the whole `/proxy/:bookmarkId`
   prefix unconditionally, whether the target specified one of its own or
   not.

Also has its own `onError` handler now (both the HTTP path and the
WebSocket path below), logging the real underlying connection error
(`ECONNREFUSED`, a TLS failure, a timeout, whatever it actually is)
server-side — there was none originally, so any connection failure fell
through to `http-proxy-middleware`'s own generic, undiagnosable message.

WebSocket support (`enable_websocket`, off by default per-bookmark) is
handled by a separate raw `upgrade` listener
(`attachBookmarkProxyWebsockets`) on the underlying `http.Server` —
WebSocket handshakes never reach Express's request pipeline at all, they're
dispatched at the Node HTTP server level, coexisting with `guacamole-lite`'s
own upgrade listener on the same server (each ignores requests outside its
own path prefix). This path has its own IP-based rate limiter, separate
from the Express-level `proxyLimiter`, since Express middleware — including
`express-rate-limit` — never runs for upgrade requests. Also has the same
`secure: false` treatment as the HTTP path (issue 1 above), for the same
reason.

---

## 11. Connections export/import (`admin.ts`, `GET`/`POST /api/admin/lists/:listId/connections/export|import`)

Modeled closely on `bookmarks.ts`'s own JSON export/import pair — same
`schema_version` envelope, same "skip malformed rows rather than fail
the whole import" behavior. Scoped to one list at a time, not the whole
deployment; not a substitute for the `scripts/backup-*.sh` tools in
Section 14, which cover Postgres/Vault/recordings wholesale rather than
one list's own connection definitions.

Credentials are excluded by default, and that's the real reason this
route exists as its own thing rather than just being folded into the
list's own metadata — a connection's credential is Vault-encrypted at
rest specifically so it's never available in plaintext outside Vault,
and writing it into a portable JSON file in plaintext would defeat that
entirely.

**`includeCredentials=true` — requested directly ("without password or
with encrypted password").** Rather than either extreme (always
omitted, or plaintext), this includes each connection's own *actual*
credential as the exact same Vault Transit ciphertext (`vault:v1:...`)
already sitting in `connection_credentials` — copied through as an
opaque string on both the export and import side, never decrypted or
re-encrypted by this route at all. This is genuinely no less secure
than the database itself already being ciphertext-at-rest, and reads
back transparently through this app's existing credential-read path on
import — but only into the *same* Vault instance that originally
encrypted it, since Transit keys are instance-specific; importing into
a different deployment's Vault restores the connections fine but
leaves their credentials permanently undecryptable there, surfacing as
the existing "won't connect" status `credentials.ts`'s own status
endpoint already reports for any missing/broken credential — not a new
failure mode invented for this, the same one that already existed for
a connection nobody had gotten around to setting a credential on yet.

**Which credential is "a connection's own" depends on its mode — this
is the fix for a real bug reported live in production shortly after
this feature first shipped, not the original design.** The first
version only ever looked for the *shared* (`user_id IS NULL`)
credential, unconditionally, regardless of a connection's own
`credential_mode`. Since `ListDetail`'s own connection-creation form
(used for both admin-managed shared lists and, via `MyListPage.tsx`,
personal lists) defaults `credentialMode` to `'individual'`, that meant
an individual connection — including the exporting person's own,
genuinely-working credential for it — was silently skipped every time.
For a personal list specifically, where the owner is the only person
who could ever have set a credential on any of their own connections at
all, "include credentials" ended up exporting almost nothing, exactly
matching what got reported. Fixed with a `LEFT JOIN LATERAL` keyed off
each connection's own `credential_mode`: a `'shared'` connection's
lookup is unchanged (`user_id IS NULL`), but an `'individual'`
connection now looks up the *exporting user's own* row specifically
(`user_id = <exporting user's id>`) — never a different user's.
Verified directly against a real database across every real
combination before trusting it: a shared connection's shared
credential; an individual connection where the exporting user's own row
exists (now correctly included, the actual fix); the identical
individual connection exported instead by a genuinely different user
(confirmed their own row is returned, never the first user's); and an
individual connection with no credential at all (confirmed nothing is
fabricated). The import side mirrors this on the way back in: a
`'shared'` connection's credential still lands with `user_id NULL`, but
an `'individual'` one is now written scoped to whoever is actually
running the import — correct, since the export route only ever
exported the exporting user's own individual credential in the first
place, never anyone else's, so there's no other user's row this could
possibly be misattributing.

The original protection this feature was built around is unchanged,
only correctly scoped: nobody's export can ever contain a credential
belonging to anyone but themselves (for an individual connection) or
the list's own shared one — confirmed directly, not just by removing
the old restriction and hoping, that a second, genuinely different
user exporting the identical list never sees the first user's own
individual credential, only their own (or nothing, if they never set
one).

Held to `credentials.ts`'s own existing permission bar, not a new one
invented for this: `requiredPermissionForCredentialMode('shared')`
already requires `admin` to set a shared credential directly, so
exporting or importing one requires the same `admin` level on the list
— `view`/`edit` remain sufficient for the metadata-only case, unchanged
from before. The import side checks this upfront, against the whole
request body, before writing anything: if *any* connection in the file
carries a credential, the entire import requires `admin`, rather than
silently importing some connections' credentials and skipping others
partway through as permission happens to run out.

Folders are exported/imported by name, not by `folder_id` — an id is
meaningless once restored into a different list or a rebuilt database
(a fresh install's folder rows have entirely new, unrelated ids even for
a folder of the same name), so importing finds-or-creates a folder by
name in the target list rather than trying to preserve the original id.

---

## 12. Frontend structure

React SPA, no router-level code splitting (~429KB bundle). Key pieces:

- **`App.tsx`** — the auth/setup gate. Checks `/api/setup/status` once on
  load, then routes: `/setup` (wizard, if incomplete), `/login`,
  `/change-password`, `/admin`, and everything else behind a
  `RequireAuth` wrapper that just checks for a session token in
  `sessionStorage` (a presence check, not a security boundary — every real
  API call still validates the token server-side).
- **`ConnectionPanel.tsx`** — an overlay, not a layout-push. This matters
  technically, not just aesthetically: the Guacamole canvas's pixel size
  is communicated to guacd via a `size` instruction, and resizing it
  mid-session (which a push-layout panel would force) means either a
  blurry rescale or an actual remote-resolution change. An overlay never
  touches the canvas's dimensions.
- **`MainApp.tsx` — multiple concurrent sessions.** Every opened
  connection stays mounted (hidden via `display: none`, never unmounted)
  so its WebSocket tunnel stays connected in the background — switching is
  instant, nothing reconnects. This raised a real correctness issue worth
  understanding: `Guacamole.Keyboard` attaches its listener to `document`
  globally, not scoped to one component's DOM subtree, so with more than
  one `SessionViewport` mounted simultaneously, every keystroke would
  otherwise reach every open session's remote host at once. Fixed with an
  `isActive` prop gating every outgoing key/mouse event in
  `SessionViewport.tsx` — only the focused session actually forwards
  input; the others keep rendering and their tunnel stays open, but send
  nothing.
  - **Switching**: a tab strip appears once more than one session is open,
    plus keyboard shortcuts — Ctrl+Alt+Left/Right to cycle, Ctrl+Alt+Up for
    an overview. These bind specifically to the **left-side** Ctrl/Alt keys
    (`event.code === 'ControlLeft'`/`'AltLeft'`, tracked via a ref rather
    than depending on component state so a rebind mid-hold can't lose
    track of "still held"), not `getModifierState`, since many
    international keyboard layouts send AltGr as a combined right-Alt+Ctrl
    for producing accented characters — binding to the left-side keys
    specifically avoids hijacking that. The listener is registered on
    `window` with `capture: true` and calls `stopPropagation()` on a
    match, so it runs before — and suppresses — `Guacamole.Keyboard`'s own
    document-level listener from also forwarding the same keystroke to
    whichever session is focused.
  - **`SessionOverview.tsx`** (Ctrl+Alt+Up) — a one-time `canvas.toDataURL()`
    snapshot of every open session's live canvas, shown as a grid; not a
    live-updating thumbnail, the same idea as an OS-level Alt-Tab preview.
  - **`SessionMenu.tsx`** — a lightweight dropdown, always available via a
    "Sessions" button in the header regardless of how many sessions are
    open (the tab strip only appears once there are two or more) — click
    to switch, × to close, dismisses on outside click or Escape. Also
    surfaces "Shared with you" (`GET /api/sessions/shared-with-me`) — live
    sessions someone else has granted this user access to, joinable
    directly from here.
  - **`UserMenu.tsx`** — the same dropdown shape as `SessionMenu.tsx`
    (reused directly: identical outside-click/Escape-close effect,
    same `session-menu`/`session-menu-item` CSS classes), requested
    directly to consolidate what had been four separate header links
    (change password, two-factor, passkeys, sign out) behind one
    trigger showing the signed-in username, freeing that header space
    for feature buttons. Fully self-contained — fetches its own
    username from `GET /api/me` and owns its own open/closed state,
    unlike `SessionMenu` which needs several pieces of its parent's own
    session state — so `AppShell.tsx` doesn't need an open-state
    variable of its own for this the way it does for the session menu.
    Verified with real `react-dom` rendering in this environment, not
    just `tsc`: the username fetch resolving into the trigger's own
    text, all three links' hrefs, the dropdown opening/closing on a
    genuine outside click vs. staying open on a click inside it,
    closing on Escape, and the sign-out callback actually firing — a
    first pass with `react-test-renderer` alone gave a false failure on
    the outside-click behavior specifically, since that renderer
    doesn't produce real DOM nodes for a ref like this to observe;
    switching to real `react-dom` rendering resolved it and confirmed
    the behavior was correct all along.

    Two direct follow-ups after this first shipped: entries are
    `<button>`s with a `useNavigate` call, not `<Link>`s (so every item
    behaves and looks identical regardless of whether it navigates or
    acts in place, like sign-out always did); and the dropdown itself
    is `width: max-content` rather than inheriting `.session-menu`'s
    own fixed 260px, the same technique `LanguagePicker.tsx`'s own
    `.language-picker-grid` already uses and for the identical reason —
    "Two-factor auth" no longer wraps onto two lines. Re-verified with
    the same real-`react-dom` harness rather than assumed fixed from
    the CSS alone: confirmed every item is a genuine `<button>` (zero
    `<a>` tags present), each with a computed `white-space: nowrap`,
    the menu's own computed width no longer the old fixed value, and —
    since `useNavigate` needed its own check distinct from `<Link>`'s
    (a `MemoryRouter` deliberately never touches the real
    `window.location` at all, so that was the wrong thing to assert on
    a first pass) — that clicking an item actually changes the
    route, confirmed by rendering the router's own current location
    into the test DOM and reading that back, not the browser URL.
- **`SessionViewport.tsx`** — the actual Guacamole client. Handles
  bidirectional clipboard sync, drag-and-drop file upload (routing to the
  RDP-drive or SFTP path depending on protocol — see Section 6 for the
  full file-transfer story, both directions), a real upload progress
  percentage (via `XMLHttpRequest`, since `fetch` has no upload-progress
  event), reconnect-with-backoff on disconnect, an optional
  `joinSessionId`/`readOnly` prop pair for joining someone else's live
  session instead of opening a new connection (Section 8), and an
  optional `adhocSettings` prop for an ad-hoc connection instead of
  either (Section 3). `connectionId` itself is optional for the same
  reason: an ad-hoc session has none. Every feature that depends on a
  real, saved `connectionId` to key its own backend lookup by
  (RDP-download polling, file upload, the Record/Share session-id
  lookup) explicitly skips itself when it's absent rather than breaking
  — the deliberate first-version scope for ad-hoc connections, not an
  oversight; the session itself still connects and works fully either
  way. On failure, shows the actual `Guacamole.Status` code and a
  human-readable description (a lookup table built directly from the real
  installed `guacamole-common-js` source's own JSDoc, covering all 19
  non-success codes it defines) rather than the bare word "error" —
  `status.message`, when guacd provides one beyond the generic
  description, is appended too.

  **Touch input**: `Guacamole.Mouse.Touchpad` runs alongside the ordinary
  `Guacamole.Mouse`, on the same element — the two listen for genuinely
  different native browser events (touch vs. mouse), so both work at once
  with no device detection needed anywhere, on a phone, a mouse-only
  desktop, or a touchscreen laptop alike. Touchpad (relative, drag-to-
  move) rather than the also-available, absolute Touchscreen variant, for
  finer control hitting small remote UI elements on a small screen,
  matching the official Guacamole web app's own stated reasoning for the
  same choice.

  **Audio**: RDP audio redirection is on by default in both
  `guacamole-common-js` and guacd's own RDP backend — nothing in this
  app's own connection parameters turns it on or off. The real,
  well-documented cause of silence, when a remote VM genuinely has a
  working audio device: every major browser creates the Web Audio API's
  `AudioContext` — which `guacamole-common-js`'s own built-in audio
  playback shares as one single, page-wide singleton
  (`Guacamole.AudioContextFactory`) — in a "suspended" state until a
  real, direct user gesture resumes it, and `guacamole-common-js` never
  does that resuming itself. The session's own first mousedown/touch
  resumes it automatically; `UnmuteButton.tsx`, next to Share in the
  toolbar, is a visible, explicit, always-available fallback for the
  same `resume()`, reflecting the context's own real, live state via its
  `statechange` event. Both APIs — `Guacamole.Mouse.Touchpad` and
  `Guacamole.AudioContextFactory` — are real, current
  `guacamole-common-js` source, confirmed directly against it, but the
  published `@types/guacamole-common-js` package doesn't declare the
  latter at all; `lib/guacamoleAudio.ts` isolates the one, necessary
  `any` cast this requires to a single, well-explained function rather
  than scattering it across call sites.
  description, is appended too.
- **`ShareSessionButton.tsx`** — owner-only, next to Record; grants/revokes
  live co-viewing access to the current session via `UserPicker`, choosing
  `viewer` or `interactive`. Revoking now also forcibly closes that
  person's own live connection directly (`disconnectJoinedUser`, Section
  8), not just the grant.
- **`ShareNotifications.tsx`** — proactive toast notifications for a live
  session someone shares with you, with a one-click Join; polls
  `GET /api/sessions/shared-with-me` every 10s (Section 8).
- **`AdhocConnectionModal.tsx`** — "Quick connect": fill in connection
  details directly and connect immediately, without saving a reusable
  connection record. Admin-only, enforced server-side
  (`issueAdhocConnectionToken`, Section 3) independent of whether the
  triggering button is even shown; the button itself is gated by a
  `GET /admin/am-i-admin` check purely so a non-admin never sees something
  that would just reject them after filling out the whole form.
- **`AdminPanel.tsx`** — tabbed (Users / Groups / Lists / Audit Log).
- **`DemoPanel.tsx`** — demo creation/curation/access-granting, reusing
  `UserPicker` and the same `openBookmark` helper (`lib/openBookmark.ts`)
  the main connection panel uses.
- **`HelpPanel.tsx`** — in-app, plain-language end-user help (distinct from
  this document and the README, which are for people working on the app
  itself), opened via a "Help" link in the main header.
- **Themes** (`themes/`) — four CSS files (Signal Dark, Daylight, Midnight,
  Comic), each defining the same fixed set of 13 CSS custom properties
  under `[data-theme='id']`, selected via `ThemePicker.tsx` and persisted
  to `localStorage` — see Section 4's own note on why this is entirely
  frontend, with no server-side involvement at all despite the `themes`
  table's presence in the schema.
- **Internationalization** (`i18n.ts`, `LanguagePicker.tsx`) — requested
  directly, with a specific requirement shaping the whole design: a new
  language should become available by dropping a file into a directory,
  not by registering it anywhere in code or rebuilding the frontend. Built
  on `react-i18next` with `i18next-http-backend` fetching translation JSON
  from `GET /api/locales/:lang` (`routes/locales.ts`) *at runtime* rather
  than bundling it — the opposite of the theme system just above, and
  deliberately so: a theme is part of this codebase, a translation is
  meant to be contributed to it by someone who may never touch the
  frontend build at all. That backend route reads its `locales/` directory
  fresh on every request rather than caching it at startup, so a file
  added while the app is already running (via the bind mount described in
  the root `README.md`'s deployment notes) is available immediately, no
  restart needed. `LanguagePicker.tsx` fetches the same directory's
  listing to populate itself — never a hardcoded list of languages — and
  resolves each one's display name via the standard `Intl.DisplayNames`
  browser API rather than a hardcoded name map, for the identical reason:
  a new community-contributed language shouldn't need a matching code
  change just to have a readable name in the picker. `fallbackLng: 'en'`
  means a translation missing a key (or missing entirely) never breaks
  anything — it falls through to English automatically. **Coverage: every
  part of the app's UI, with no known remaining exceptions**, pulls its
  text from translation files — every screen and modal covered
  throughout this feature's rounds, including the two admin-only
  sub-sections reached from within `ListDetail`
  (`BookmarksAdminSection.tsx`, `RecordingsAdminSection.tsx`),
  `HelpPanel.tsx`'s own long-form prose, and — closing what had been the
  one deliberately deferred piece — `SetupWizard.tsx`, the one-time
  first-run flow. `locales/en.json`'s own key structure is the reference
  for the exact, current key set.
  Two small, directly related fixes landed alongside completing that
  coverage. First, `.toLocaleString()`/`.toLocaleDateString()` calls in
  the audit log, the recordings list, and demo grant expiries previously
  passed no locale argument at all, so dates always rendered in the
  browser's own locale regardless of which language someone had picked
  in the app — passing `i18n.language` into each call fixes this, and
  was confirmed directly (not assumed) to genuinely change the resulting
  format, not just accept the argument silently: Greek renders dates as
  DD/MM/YYYY with "μ.μ." for PM, distinctly different from English's
  MM/DD/YYYY and "PM", proving the argument actually takes effect.
  Second, `registry.ts`'s `getSavedThemeId()` now picks an OS-appropriate
  initial default (`prefers-color-scheme: light` → Daylight, dark or no
  preference expressed at all → Signal (Dark)) the first time anyone
  visits in a given browser, rather than always defaulting to Signal
  (Dark) regardless of the OS's own setting — but only as a one-time
  initial default: it never overrides an explicit choice already saved,
  even one that ends up mismatching the OS's current setting, and it
  doesn't keep watching for OS-level changes afterward. Verified against
  five real scenarios (no `matchMedia` support at all, OS light with
  nothing saved, OS dark with nothing saved, an explicit saved choice
  that mismatches the OS setting, and a stale/removed saved theme id) —
  see `themes/README.md`'s own "Initial default" section for the
  contract.
  Worth being explicit about *how* the remaining i18n gaps were actually
  found in the round before this one, since it changed the process
  going forward: two separate rounds of "we missed X" against
  components that genuinely weren't reached through `AppShell.tsx`'s
  persistent chrome (a code-level review of "every component the shell
  renders directly" doesn't surface a component that's only ever
  imported by another component three files away, the way
  `BookmarksAdminSection.tsx` is only reached through `ListDetail`) made
  clear that reasoning from memory about "what the app contains" wasn't
  reliable. What actually closed the gap was mechanical, not visual:
  grepping every component file for i18n import presence against a
  rough count of capitalized, sentence-like JSX text, then manually
  inspecting every file the two signals disagreed on — a repeatable
  check that doesn't depend on remembering the app's full component tree
  correctly, unlike a mental or visual sweep; the same check, re-run
  after this change, is what confirms `SetupWizard.tsx` was the last
  remaining gap and nothing else slipped through. Getting Help's own
  prose right, specifically, needed
  `react-i18next`'s `Trans` component rather than plain `t()` calls:
  several of its paragraphs have `<strong>` spans in the middle of a
  sentence (button names, key names), and `Trans` is what lets a
  translation reorder words freely around those spans while the actual
  bold JSX elements stay real HTML, not literal `<strong>` text —
  confirmed directly, not assumed, with a real component render in both
  languages checking for missing keys, console errors, and leaked raw
  key names, which is what caught (and let get fixed before shipping)
  two places where an explicit `{' '}` spacing expression in the JSX
  shifted `Trans`'s own child-tag numbering by one from what the
  translation strings had assumed. `fallbackLng: 'en'` still means a
  translation missing a key never breaks anything — this is a complete
  pass proving every part of the mechanism works end-to-end across the
  whole app, not a claim that every string ever added from here on will
  always be translated the moment it's written. See
  `locales/README.md` for the actual contributor-facing workflow.

---

## 13. Testing — three layers, honestly labeled by verification status

Full detail in `docs/TESTING_PLAN.md`; summary here.

**Layer 1 (unit, `backend/src/**/*.test.ts`) — done and verified.** 313
tests across 26 files, all genuinely run via `vitest` (wired into
`.github/workflows/ci.yml`), covering every item on the plan's original
blast-radius-ordered priority list: the guacd tunnel's authorization gate,
credential-mode branching (now including AD passthrough), Vault token
caching/refresh, the bookmark
proxy's cookie/token layer, demos' ownership/grant logic, the CSRF
service, the ad-hoc connection token's admin gate and input validation,
the explicit joined-session disconnect logic, the idle-timeout/absolute-max
session logic, the passkey registration/authentication ceremonies (service
layer and route layer both), LDAP authentication against Active
Directory (including the empty-password bind guard — see Section 16),
the connections export/import route's
permission gating and shared-vs-individual-vs-AD-passthrough credential
filtering, and the
language-discovery
route's path-traversal rejection and real-UTF-8-content handling. Several
pieces of logic were extracted out of inline closures into named exported
functions specifically to make this possible (the
`guacTunnel.ts`/`credentials.ts`/`demos.ts`/`locales.ts` pattern) — none of it was
independently callable before.

**Layer 2 (integration, `backend/tests-integration/`) — drafted, never
executed.** A real-Postgres harness via `testcontainers`
(`tests-integration/harness.ts`) plus five test files covering the setup
wizard end-to-end, login flow, list permissions, demo access and expiry,
and the credential write path (verified against real Postgres rows, not
just mocked SQL parameters). Required splitting `server.ts` into `app.ts`
(`createApp()`, no side effects, so `supertest` can mount it directly) and
extracting `migrationRunner.ts` so tests run the identical migration chain
production does. All five files type-check — genuinely confirmed via
`--listFilesOnly` after an inherited-`tsconfig`-exclude false positive
initially reported a clean result while silently checking zero files.
Blocked on Docker, which has never been available anywhere in this
project's environment.

**Layer 3 (e2e, `e2e/`) — scaffolded, never executed.**
`docker-compose.test.yml` (a throwaway stack, dev-mode Vault, a disposable
SSH target, a static page standing in for an internal-only proxy target),
`e2e/vault-init.sh` (bootstraps Vault's Transit engine plus a fully
deterministic AppRole — both `role_id` and `secret_id` pinned via Vault's
own custom-ID parameters, so the whole bootstrap is reproducible with a
static `.env.test`), and `e2e/tests/full-journey.spec.ts` (one sequential
Playwright journey; 4 of 7 target flows fully scripted, 3 left as honest
`test.fixme()` stubs rather than faked passes). Also blocked on Docker.

A recurring, explicitly-recorded lesson: several things marked "done" in
earlier work were wrong until actually compiled or run — a missing
`express-session` dependency that would have crashed the setup wizard, a
test file that silently never executed due to a `vi.mock` hoisting bug, a
duplicate route registered by two different files, a wrong assumption
about the `guacamole-common-js` Mouse API, and — a second instance of the
same lesson one level up — a `tsconfig.test.json` that reported a false
"all clean" because it had silently inherited an `exclude` and was
checking zero files. The general takeaway, stated in `TODO.md`: run tools
and check what they actually touched, rather than trusting an exit code or
re-reading code as a substitute for execution.

---

## 14. Operational tooling

- **TLS**: plain HTTP by default (put your own reverse proxy/TLS in front,
  same as any internal tool) — required for passkeys specifically, which
  the browser itself refuses to expose outside a secure context (Section
  5's own note on this). Two optional Caddy overlays cover it either way:
  `docker-compose.caddy.yml` for automatic Let's Encrypt issuance (needs
  a real public domain and ports 80/443 reachable from the internet), or
  `docker-compose.caddy-internal.yml` for a self-signed certificate via
  Caddy's own `tls internal` directive — no public domain, no open ports
  beyond 443 itself, works for a bare IP just as well as a hostname.
  Verified directly, not just read from Caddy's own docs: installed a
  real Caddy binary in this environment, validated `Caddyfile.internal`'s
  syntax, then actually ran it and completed a genuine TLS handshake
  against it (`openssl s_client`), confirming a real certificate signed
  by "Caddy Local Authority" for a bare IP address, not merely that the
  config parses.

  **Deliberately kept as separate overlay files, not merged into
  `docker-compose.prod.yml`/`.dev.yml`/`.test.yml` — asked directly, and
  checked with a real Compose binary rather than reasoned about in the
  abstract.** Caddy's `${DOMAIN:?...}` requirement fails Compose's own
  config parsing for the *entire* file if unset, confirmed to fire even
  for a service gated behind a `profiles:` entry (env interpolation
  happens before profile filtering) — merging would force `DOMAIN` to be
  set just to run the plain-HTTP default, whether Caddy is wanted or
  not. Confirmed the overlay file's own inclusion is genuinely what
  gates the check: the base file alone parses cleanly with `DOMAIN`
  unset, and only fails once the overlay is actually requested.

  **A real, pre-existing bug found and fixed along the way, not merely a
  design question answered**: both overlays' own `frontend: ports: []`
  — meant to unpublish the frontend's direct HTTP port once Caddy is
  the sole entrypoint — was a silent no-op. Compose treats `ports`
  (along with `volumes`, `secrets`, `configs`) as a uniqueness-keyed
  sequence on merge (matching/appending by `{ip, target, published,
  protocol}`), never replacing the list wholesale; an empty list has
  nothing to match the base's own port entry against, so the base's
  `8443:8080` publish survived untouched, letting anyone bypass Caddy
  entirely by hitting the frontend's own port directly. Confirmed as a
  live bug this way, not just reasoned about: ran the actual merged
  config for both real overlays through `docker compose config` and
  found the port still published in the output. Fixed with the
  explicit `!reset` YAML tag (`ports: !reset []`) — Compose's own,
  documented mechanism for actually clearing an inherited sequence —
  and re-verified the same way: the fixed merged config now shows no
  `ports:` on `frontend` at all, for either overlay.

  **`Caddyfile.internal` redesigned around on-demand TLS — a real,
  live failure reported and reproduced, not a design choice made up
  front.** Its first version bound the site block to one fixed
  `{$DOMAIN}` value; a real deployment set `DOMAIN` to the host's bare
  IP, then browsed to an internal DNS name for the same host instead —
  a perfectly reasonable, common thing to do — and got a hard browser
  "can't establish a secure connection" failure, not a certificate
  warning. Reproduced directly before writing any fix: a real Caddy
  instance, `openssl s_client -servername <the-other-name>`, and the
  exact same TLS alert the browser was hitting — confirmed the cause
  was the fixed-hostname site block having no certificate to offer for
  any other name, not a DNS or connectivity problem as first suspected.
  Fixed by switching to on-demand TLS (`tls internal { on_demand }`)
  with the site block bound to `:443` (any hostname), so a certificate
  is minted automatically for whichever hostname or IP a request
  actually arrives on — `DOMAIN` is no longer read by this file, or
  required by `docker-compose.caddy-internal.yml`, at all. On-demand
  TLS is normally gated behind a required "ask" permission endpoint
  specifically to stop unbounded certificate issuance against a real,
  rate-limited CA — confirmed directly against Caddy's own source
  (`modules/caddytls/ondemand.go`) and a linked upstream issue
  (caddyserver/caddy#5986) that `tls internal` specifically, alone, is
  a documented exception to that requirement, since there's no external
  CA or public rate limit at risk with a certificate this app's own
  Caddy mints itself — not assumed safe, confirmed by running a real
  on-demand config with zero "ask"/rate-limit configuration present and
  watching it correctly, independently mint distinct valid certificates
  for three different, previously-unconfigured hostnames in the same
  run. Re-verified the original failure is actually fixed the same way
  it was reproduced: the real `Caddyfile.internal`, run for real, now
  accepts both the bare-IP and the internal-DNS-name connections in the
  very same running instance, no restart or reconfiguration between
  them.
- **Backup/restore** (`scripts/`): `backup-postgres.sh`/`restore-postgres.sh`
  via `pg_dump`/`psql` through the running compose container;
  `backup-vault.sh`/`restore-vault.sh` via `docker run --volumes-from`
  against the live Vault container (deliberately not assuming the
  Compose-project-prefixed volume name). Both restores require typing a
  confirmation phrase first. `backup-all.sh` runs both for a single cron
  entry.
- **CI** (`.github/workflows/ci.yml`): `backend-tests` (fast, blocking,
  runs on every push), plus `backend-integration-tests` and `e2e-tests`
  (both `continue-on-error: true`, since GitHub Actions' Ubuntu runners
  have Docker but neither job has ever actually run yet).
- **Release** (`.github/workflows/release.yml`): on a version tag, builds
  and pushes all three images, then assembles a downloadable zip
  (migrations, compose files, `.env.example`, `scripts/`, docs) — someone
  downloading a release never needs the source repo or a build toolchain,
  only `docker compose up -d`.

---

## 15. Appliance image: a Buildroot-based OVA and portable QEMU bundle

`buildroot/` — a purpose-built Linux appliance (Buildroot + systemd +
Docker) that boots straight into the full `docker compose` stack, packaged
two ways from the same build: a `.ova` for vSphere/ESXi import, and a
portable `qemu-system-x86_64` bundle that needs no hypervisor
infrastructure at all — copy it anywhere QEMU is installed. Same overall
shape as the AsBuiltReport Manager appliance, adapted for this app's
specific needs: seven containers instead of one Dockerized tool, a
persistent data disk separate from the OS disk, and Vault's own
init/unseal lifecycle.

**Never built or booted, either output** — no Buildroot toolchain, kernel
source, `qemu-img`, `genimage`, QEMU/KVM, or VMware environment was
available while writing it. What *was* done: every Buildroot config
symbol and package name was checked directly against Buildroot's real
source (`github.com/buildroot/buildroot`) before being used, the same
discipline applied to the `guacamole-lite` work in Section 8. That caught
three real mistakes early: the actual package name is `openvmtools` (no
hyphens, not `open-vm-tools`); an initial draft selected both `dhcpcd` and
systemd-init, which would have fought over DHCP — fixed to use
`systemd-networkd` consistently once systemd is already in the picture;
and QEMU's default `virtio-blk` disks show up as `/dev/vda`/`/dev/vdb`,
which would have silently broken the first-boot script's `/dev/sdb`
data-disk assumption (written against VMware's PVSCSI naming) — fixed by
using `virtio-scsi` in the QEMU launch script instead, confirmed against
Buildroot's own real QEMU board config for the exact kernel symbol needed.

**Two-disk design**: `docker-compose.appliance.yml` redirects every
persistent volume (Postgres, Vault, recordings) onto bind mounts under
`/data` — a separate virtual disk from the OS disk (see
`ovf-template.xml`'s two `<Disk>` entries) — so replacing the appliance's
OS disk on an upgrade never touches persistent state. The OS disk stays
small (4GB); the data disk defaults to 200GB, formatted by
`guac-appliance-firstboot.sh` on first boot only (it ships as an empty,
sparse VMDK).

**A real design problem found while writing the first-boot script, not
just a scripting detail**: production Vault
(`docker-compose.prod.yml`) uses file storage, not dev mode, meaning it
needs a genuine `vault operator init`/`unseal` — and **re-seals on every
container restart**, including every VM reboot. A first-boot-only script
would have left the appliance silently broken after the very first
restart. Fixed with a separate `guac-appliance-vault-setup.sh` that runs
on *every* boot: initializes Vault once (a single unseal-key share,
appropriate for a self-contained appliance with no other infrastructure to
split shares across), unseals on every subsequent boot using that saved
key, and bootstraps the Transit engine + AppRole exactly once — the same
pattern `e2e/vault-init.sh` uses for the disposable test stack, but
against a real, persistent production Vault instead. The unseal key and
root token are written to a plaintext file on the data disk with an
explicit warning to retrieve and secure it — the script does not delete
it automatically, since destroying the only copy on a misconfigured backup
workflow would be worse than leaving it in place briefly.

OVF properties (network mode/IP, public URL, optional syslog host) are
read via `open-vm-tools`' guest-info channel and applied at first boot;
everything else — creating the first admin account — goes through the
app's own existing web setup wizard, deliberately not duplicated as a
second onboarding path. Full detail, including honestly-labeled known
gaps (no SSH key provisioning yet, the `/dev/sdb` data-disk assumption
unconfirmed against real vSphere), in `buildroot/README.md` — and the
QEMU-specific path, including the virtio-scsi reasoning and the
seed-ISO mechanism, in `buildroot/board/guac-appliance/README-qemu.md`.

---

## 16. Active Directory (`services/activeDirectory.ts`, `routes/auth.ts`, migrations 021–022)

Requested directly, scoped specifically to what was asked for at each
stage — AD-group-gated login (any account in one configured AD group
can sign in), optional AD-credential passthrough for a connection's own
RDP/SSH session, and, added afterward once AD login itself was
reported genuinely working end to end, a real, ongoing sync of AD
group membership into this app's own `groups` (Section "AD group
sync" below) — not a full mirror of AD's own directory structure into
this app's own model wholesale, but a real, bidirectional (add and
remove) sync for whichever specific AD groups are actually mapped. A
local account created before AD was ever turned on and a real AD
account sharing the same username are kept as two entirely separate
identities forever, never merged: `users.auth_source` (`'local'` |
`'ad'`, migration 021) is authoritative once a row exists, checked
explicitly rather than inferred from `password_hash` being null.

`ldapts`, not `ldapjs` — checked directly before writing anything
against either, not assumed from prior training data: `ldapjs`'s own
README states it was formally decommissioned by its maintainer in
2024. `ldapts` is the actively maintained, TypeScript-first successor,
confirmed against its own shipped `.ts` source (it ships source
directly, no separate `.d.ts` files) rather than assumed compatible
from its package description alone.

**The empty-password bind bypass — the one piece of this integration
treated as genuinely critical, not routine defensive programming.**
RFC 4513 §5.1.2 defines a Simple Bind with a real DN but an *empty*
password as a distinct, valid operation — an "unauthenticated bind" —
which many LDAP servers, Active Directory's own default configuration
included, answer with success rather than rejection. Skipping this
check is a real, repeatedly-exploited authentication bypass — searched
for confirmation before writing the guard, not after: CVE-2026-44551
(Open WebUI), CVE-2026-41720 (Spring LDAP), CVE-2026-90961 (MISP), and
GHSA-5hmm-x8q8-w5jh (Alerta) are all exactly this same omission, not
novel attacks each time. Confirmed `ldapts`'s own `bind()` does nothing
to guard against this itself (read its source directly rather than
assumed), so `authenticateAgainstAd()` rejects an empty password
outright, before constructing any LDAP client connection at all — a
dedicated test (`activeDirectory.test.ts`) asserts zero LDAP client
construction for this case specifically, not just the right final
answer reached some other way.

**Login flow (`routes/auth.ts`)**: local and AD accounts share one
`/login` route and one rate limiter, not a separate `/login-ad`
endpoint — the login form never needs to know in advance which kind of
account a username belongs to. `auth_source` decides the path: an
existing `'local'` row never falls through to AD regardless of AD
being enabled (confirmed with a dedicated test using a genuine, valid
argon2 hash — an early version of this same test used a fake,
malformed hash string and crashed with an unhandled rejection inside
`argon2.verify` itself, a real bug in the test's own setup, not the
route, caught and fixed before this shipped); a username with no local
row at all, or an existing `'ad'` row, is AD's to try. A previously
provisioned AD account this app has separately disabled
(`users.disabled_at`) is rejected before even attempting the AD bind —
a real gap caught while building this, not present from the start:
without this explicit check, an admin's existing "disable user" action
would have had no effect at all on an AD account, silently.

**JIT provisioning (`findOrProvisionAdUser`)**: a local `users` row is
created on an AD account's first successful login, reusing
`userProvisioning.ts`'s own `provisionPersonalList` — an AD-provisioned
account starts with exactly the same personal "My Connections" list a
locally-created one does, not a stripped-down variant. Deliberately
never provisioned ahead of a first real login: the entire point of
gating by AD group membership is that an admin doesn't have to
pre-create every future group member's account by hand.

**2FA after a successful AD login is deliberately not a separate,
configurable policy at all** — a design simplification found while
building this, not the originally assumed shape of the problem. The
shared `completeLogin()` helper (used by both the local and AD paths)
keys entirely off the account's own `totp_enabled`, exactly the same
way for both kinds of account: an AD account that's voluntarily turned
on TOTP or a passkey for itself (self-service, from the header's own
user menu — Section 12) is asked for it on every subsequent login,
exactly like a local account with it enabled would be; one that
hasn't, isn't. No `AD_REQUIRE_2FA`-style toggle needed at all, since
this existing, per-account mechanism already covers it correctly.

**AD passthrough credentials (`ad_passthrough_credentials`, migration
021)**: captured only immediately after `authenticateAgainstAd()`
itself returns `ok: true`, with the exact same password that already
passed that real bind — never stored ahead of, or independent from, a
successful login. Vault-encrypted at rest, the same as
`connection_credentials`' own stored values (`services/vaultClient.ts`).

Expiry uses `SESSION_ABSOLUTE_MAX_HOURS`, not
`SESSION_IDLE_TIMEOUT_MINUTES` — a real design correction made before
shipping, not the original choice: the app's own session token is a
sliding window, refreshed on every request (`requireAuth.ts`), so an
actively-used session can genuinely outlive a single idle-timeout
window by a lot. Tying this credential's own expiry to that fixed,
shorter window instead would have meant an actively-used session's own
AD credential quietly going stale mid-session, well before the session
itself ever did — reaching an `ad_passthrough` connection at all
already requires passing `requireAuth`'s own check on the session
token first, which is what actually gates ordinary, idle-based
staleness; this credential's own expiry is the hard ceiling behind
that, not a duplicate of it.

There's deliberately no explicit sign-out hook for clearing this early
— this app's own sessions are stateless JWTs, verified per-request
rather than tracked server-side (`services/sessionToken.ts`), so
"signing out" has never been a server-side event here at all; the
client simply discards its own token. `clearAdPassthroughCredential`
is instead called from the one place it's genuinely, currently known
to be needed immediately: `admin.ts`'s own "disable user" route — an
admin's disable should take effect right away, not wait out whatever's
left of this row's own separate expiry window (this had zero test
coverage of any kind before this feature added it, not just for the
new AD-specific behavior).

**Connection-level passthrough (`routes/tunnelToken.ts`)**:
`connections.credential_mode` gains a third value, `'ad_passthrough'`
(migration 021's own `CHECK` constraint), alongside the existing
`'shared'`/`'individual'`. `issueNewConnectionToken` branches on it:
an `ad_passthrough` connection reads the caller's own currently-cached
AD credential (`getAdPassthroughCredential`) and never touches
`connection_credentials` at all for that connection, confirmed
directly by a test asserting exactly one `db.oneOrNone` call total (the
connection lookup itself) rather than the usual two. A distinct result
status, `ad_credential_unavailable`, rather than folding this into the
existing `no_credentials_configured` — these are genuinely different
situations for the person hitting them: one means an admin never
finished setting the connection up, the other means this specific
user's own AD session has simply gone stale (or, for a local account
opening an `ad_passthrough` connection, never existed at all, by
design), and the two deserve different messages rather than one
generic "not configured" covering both.

**Setting AD passthrough on a connection (`admin.ts`,
`EditConnectionModal.tsx` / `AddConnectionForm.tsx`)**: both the create
and update connection routes validate `credentialMode` explicitly
against a real allow-list now, rather than relying on the database's
own `CHECK` constraint to reject a bad value — the constraint alone
would have surfaced as a raw, unhandled 500, not a clean 400. Both
routes additionally reject `'ad_passthrough'` specifically when AD
isn't enabled on this deployment at all, even via a direct API call
bypassing the connection form's own client-side gating — the form only
ever offers the option once `GET /api/admin/ad-status` says it's
available, but that alone is never treated as sufficient enforcement
on its own anywhere else in this app, and isn't here either. The
export/import round trip (Section 11) gets the same treatment: an
imported row's own `'ad_passthrough'` mode is preserved rather than
silently defaulted to `'shared'` when AD is enabled, and skipped
outright (counted as `skipped`, not `imported`) rather than
silently downgraded when it isn't — a downgrade would instead leave a
connection permanently, confusingly failing with
`no_credentials_configured` with no indication why, the exact
confusion a distinct `ad_credential_unavailable` status above exists
to avoid elsewhere in this same feature.

`GET /api/admin/ad-status` itself is deliberately **not**
`requireAdmin`-gated — a real bug caught before it shipped, not the
original design. `AddConnectionForm.tsx` is specifically the
regular-user-facing connection form (any user with `edit` on a list
can create a connection there, admin or not, per that component's own
long-standing doc comment) — gating this status check behind
`requireAdmin` would have meant every non-admin user got a permanent
403 here and could never see or choose AD passthrough at all, even on
a deployment where it's fully enabled. Caught by tracing through who
actually calls this endpoint, not assumed safe merely because most of
this file's other routes are admin-gated that way. What it actually
reveals — one boolean, whether AD is configured at all — carries none
of the sensitivity an admin-only gate exists to protect in the first
place (unlike, say, `AD_BIND_DN` or `AD_REQUIRED_GROUP_DN` themselves,
neither of which this endpoint exposes); `requireAuth`'s own global
middleware, already covering every `/api/*` route including this one,
is enough on its own.

**Two real, live gaps found and fixed after the fact, from a real
deployment unable to diagnose its own failed AD login — not part of
the original build.** `authenticateAgainstAd`'s outer `catch` was a
bare `catch {}`, discarding the real underlying error entirely —
meaning a genuine connectivity/config problem (unreachable `AD_URL`, a
TLS handshake failure, a wrong `AD_BIND_DN`/`AD_BIND_PASSWORD`) left
nothing anywhere, in any log, to diagnose it by. Separately, `auth.ts`
computed `adResult.reason` (which of the several distinct failure
cases actually happened) but never recorded it anywhere either — the
audit log entry for every failed AD login looked identical regardless
of whether it was a wrong password, a real account not in the required
group, or AD being unreachable entirely. Fixed with a `console.error`
on the first (visible via `docker compose logs backend` — an
operational/config problem, not a per-login event, so it goes where
any other startup/config error in this app would surface) and by
adding `reason` to the audit log's own `detail` object on the second
(safe specifically because the audit log itself is admin-only — the
browser-facing response stays deliberately generic either way, exactly
like a wrong local password). Two new tests cover these directly:
`activeDirectory.test.ts` asserts the real error object reaches
`console.error` for a genuine bind failure; `auth.test.ts` asserts the
audit log's `detail.reason` for a failed AD login. Both fixes and their
tests were written and manually verified as far as possible (valid
JavaScript syntax via `node --check`, reviewed against this file's own
existing type patterns) but not run through the real `tsc`/`vitest`
pass the same round they were written — `npm install` hit a persistent
registry `403` in that session; see `TODO.md`'s own entry on this,
which the next successful install should resolve and confirm.

That real deployment's own actual failure, once the first fix above
made it visible at all, turned out to be exactly the single most
common real-world cause: `UNABLE_TO_VERIFY_LEAF_SIGNATURE` — a
domain controller's LDAPS certificate issued by that organization's
own internal/enterprise CA, which Node.js doesn't trust by default
(confirmed directly against Node's own TLS documentation, not assumed:
the `ca` option on `tls.connect` — which `ldapts`'s own `tlsOptions`
passes straight through — is exactly and only for trusting additional
CAs beyond Node's bundled public set). Given this is the normal case
for a real AD environment rather than an edge case, added first-class,
documented support rather than leaving it to a manually-set,
undocumented Node environment variable: a new `./ca-certs/` bind mount
(`docker-compose.prod.yml`/`.dev.yml`, same "drop a file in, no
rebuild" pattern `./locales` already established) plus
`NODE_EXTRA_CA_CERTS` in `.env.example`, both fully documented,
including `ca-certs/README.md`'s own walkthrough for exporting the
right certificate from a domain-joined Windows machine.

**A real, live troubleshooting session against a real AD deployment
surfaced three genuinely different problems stacked on top of each
other, each independently confirmed rather than assumed, that led to
`scripts/check-ad-cert.ts` (`npm run check-ad-cert`,
`ca-certs/README.md`'s own recommended first step).** In order:

1. **`error:80000002:system library::No such file or directory` from
   Node's own extra-CA loader is a known, misleading OpenSSL error
   string** — confirmed against Node's own issue tracker and several
   independent real-world reports of the identical message before
   trusting that reading, not assumed from the text alone: it fires
   both for a genuinely missing file and for a file Node simply
   couldn't parse as PEM, with no way to tell which from the message
   itself.
2. **`certutil -ca.cert` writes its output file as binary DER by
   default**, while separately printing a PEM-looking preview to the
   console purely for the operator's own benefit — confirmed directly
   by inspecting the file's own raw bytes (`file` correctly identified
   it, `cat -A` showed the CRLF-terminated text) against what the
   console had shown; they didn't match. `certutil -encode
   infile.cer outfile.pem` is Microsoft's own documented fix,
   confirmed against multiple independent sources, not just one.
3. **The deepest of the three**: even a genuinely well-formed PEM file
   still failed real signature verification against the domain
   controller's actual, live certificate — confirmed cryptographically,
   not just by comparing subject/issuer name text (which matched, and
   was actively misleading on its own): the CA had been re-keyed at
   some point, so a certificate pulled from a client machine's own
   Certificate Manager trust store was a stale, superseded copy sharing
   the same CN as the CA that's actually signing certificates today.
   Confirmed two ways: directly comparing each certificate's own
   Subject/Authority Key Identifier extensions by hand during the live
   session, and later, in the script itself, via
   `leaf.verify(ca.publicKey)` — checked directly against
   `X509Certificate.checkIssued()` first, since that looked like the
   more obviously "correct" built-in method for this exact check, and
   found, by testing both against a deliberately constructed
   same-name-different-key pair, that `checkIssued()` returns `true`
   for the impostor too (it appears to check only the name
   relationship, not the actual signature) — `verify()` is what the
   script actually uses as a result, not the method that looked most
   purpose-built for the job at a glance.

The script itself packages exactly these checks (file readability, PEM
vs. DER detection, a real TLS connection to `AD_URL` capturing the
actual live peer certificate, and — when the handshake fails with
either `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `CERT_SIGNATURE_FAILURE`,
confirmed to both mean the identical underlying problem here, reported
inconsistently by the exact same deliberately-mismatched test pair
across different runs/environments — the real-key-mismatch check
above), deliberately meant to run inside the real backend container
(`docker compose exec backend npm run check-ad-cert`) rather than
anywhere else: an identical check run from a different Node/OpenSSL
build gave a different, misleadingly clean result during the real
session this was built from, the same class of environment-dependent
variance the empty-password bind guard's own CVE research (above) was
also about, just surfacing here as a false negative instead of a
missed vulnerability.

**AD group sync (`syncAdGroupMemberships`, migration 022) — a real,
reported gap closed as a direct follow-up, not part of the original
scope.** Once AD login itself was confirmed genuinely working
end-to-end, a real, live consequence of the original, narrower design
surfaced immediately: a JIT-provisioned AD account got its own personal
list (`provisionPersonalList`, same as any new account) but was never
placed into any of this app's own `groups` at all, so most of the app
— every shared list, anything gated by group-based permissions — was
simply inaccessible to it, with nothing to fix that automatically the
way a locally-created account's own admin-driven creation flow
naturally would.

Asked directly which of two real shapes to build rather than assumed:
a single, fixed default group every AD account lands in regardless of
which AD groups they're actually in, or genuine, multiple
DN-to-local-group mappings closer to a real sync — the latter is what
was actually requested, and what got built.

`AD_GROUP_MAPPINGS` is a JSON array
(`{"dn": "...", "localGroup": "..."}` pairs), not a delimited string of
any kind — deliberately, since an LDAP DN always contains its own
commas (`CN=...,OU=...,DC=...,DC=...`), which would make any
comma/semicolon-delimited format for *multiple* pairs genuinely
ambiguous to parse; JSON sidesteps this entirely by treating each DN as
one opaque string value. Parsed once, at module load, the same as
every other `AD_*` setting here — invalid JSON, or an array containing
something that isn't a `{dn, localGroup}` object, is logged and
skipped rather than crashing the app over a config typo (confirmed
directly: a genuinely malformed value produces a console warning and
an inert, empty mapping list, not an unhandled exception).

Auto-creates a mapped local group the first time it's actually needed,
rather than requiring an admin to pre-create it through the ordinary
admin panel first — requested directly, since requiring that extra
manual step ahead of time would have been exactly the kind of gap this
feature exists to close in the first place, just moved one step
earlier.

**A genuine, ongoing sync, re-evaluated on every login — not a
one-time grant at first creation.** Called from `auth.ts`'s login route
right after every successful AD authentication, first-time or repeat
alike, using that same login's own, just-fetched `memberOf` (already
retrieved during the LDAP search for the login itself — see
`AdAuthResult.memberOf`, threaded through rather than re-fetched
separately). A group someone is no longer an AD member of is removed
here too on their very next login, not just added to when they newly
qualify — the actual point of calling this a sync rather than a
one-time provisioning step.

The real design problem removal raised, solved with a `user_groups.source`
column (`'manual'` | `'ad_sync'`, migration 022) rather than a
timestamp, a separate join table, or inferring provenance from
anything else: the removal step has to be able to tell its own,
previous additions apart from a membership an admin granted by hand
through the ordinary admin panel, or it would either (a) constantly
undo a real admin decision the moment someone's current AD group
membership doesn't happen to include a matching mapping, or, to avoid
that entirely, (b) never be able to safely remove anything
automatically at all — undermining the whole "current, not just once"
point of calling this a sync rather than one-way provisioning. The add
side reflects this too: `ON CONFLICT (user_id, group_id) DO NOTHING`,
not an upsert — a row that already exists, whatever its own `source`
already is, is left completely alone, so an existing manual grant is
never silently reclassified as sync-owned and made removable by some
later AD change.

Two consequences of this worth being explicit about, confirmed
directly (a real Postgres instance being unavailable in this
environment — a broader `apt`/`npm` registry issue, not
specific to Postgres — meant this needed a different, still-real
verification path: the actual TypeScript stripped to plain JS, wired
against a genuine, stateful in-memory mock of the `groups`/`user_groups`
tables, and run against six real scenarios — new-group auto-creation,
adding a second membership alongside an existing one, removal on
losing AD access, a manual grant surviving that same removal untouched,
the fully-unconfigured no-op case, and malformed-JSON graceful
degradation — all genuinely executed, not just read over):

1. An admin manually adding someone to a group `AD_GROUP_MAPPINGS` also
   maps them into doesn't get touched by sync at all afterward,
   regardless of what their AD `memberOf` later says — confirmed
   directly rather than assumed from the `ON CONFLICT DO NOTHING`
   clause's own presence alone.
2. An admin manually *removing* someone from a group that's currently
   sync-derived doesn't stick — their very next login re-adds it, since
   their own current AD membership is the actual source of truth for
   that specific membership, not the local row's own, momentary
   presence or absence. Documented plainly in `README.md` precisely
   because, without knowing this is the intended behavior, it would be
   easy to mistake for a bug the first time someone hits it.

---

## 17. User removal (`services/userRemoval.ts`, `routes/admin.ts`, migration 023)

Requested directly, as a distinct need from the existing disable
feature — disable alone never frees a username or removes the account
from the users list, since it only ever sets `disabled_at`.

The real problem this raised before any of the actual removal logic:
several tables reference `users(id)` with no `ON DELETE` clause at all,
defaulting to RESTRICT — checked directly against the real migration
files, not assumed — meaning a plain `DELETE FROM users` would fail
outright for almost any real account, since a single login already
writes an `audit_log` row. Migration 023 fixes this with `SET NULL`
(preserve the row, drop the now-gone identity reference) rather than
either RESTRICT or a wholesale CASCADE, for every audit/compliance-
relevant table this touches: `audit_log`, `sessions.owner_user_id`,
`session_recordings.user_id` ("who pressed record" — exactly the kind
of thing this app's own compliance posture exists to keep),
`session_shares.granted_by_user_id`. The one exception,
`session_participants.user_id`, is part of that table's own composite
primary key — Postgres never allows a null primary-key column under
any circumstances, so that one is CASCADE instead, removing only that
person's own join/leave rows, never the session itself.

A real, separately-discovered bug fixed along the way, not something
this feature introduces: `demos.owner_id` was `ON DELETE CASCADE`,
despite demos being explicitly designed (see migration 011's own
comment) to be shared with other people independent of who owns the
underlying connections — removing a demo's owner would have destroyed
the whole demo, and everyone else's access to it, even though nothing
about removing one account should ever affect a completely different
person. Checked against the actual route code (`routes/demos.ts`)
before changing this: every ownership check there compares `owner_id`
to a real user's own id, which simply never matches `NULL` — an
orphaned demo safely becomes unmanaged by any one specific person, not
broken for its existing viewers. Changed to `SET NULL`, matching
`connection_lists.owner_id`'s own, already-correct pattern from
migration 002.

`audit_log` specifically also gets a new `removed_user_username`
column, populated once, at removal time — deliberately not added to
every other touched table: `audit_log` is this app's own primary,
explicit audit/compliance record (its own admin UI tab, syslog
forwarding), not just incidental operational data the way
`sessions`/`session_recordings`/`session_shares` are, so losing the
human-readable "who" the moment `user_id` goes to `NULL` would
meaningfully weaken exactly the record that column exists to keep, in
a way losing it from the more operational tables doesn't.

`removeUser` (the service function) explicitly deletes only the
account's own personal list (`is_personal = true`) before deleting the
user row itself — a *shared* list this account happened to own is
deliberately left alone, relying on `connection_lists.owner_id`'s own
`SET NULL` rather than anything explicit here, since other people may
still depend on it. All of this runs in one `db.tx()` transaction
(matching the same pattern already established in
`migrationRunner.ts`), not because any one step is individually likely
to fail, but because a partial removal — audit rows snapshotted,
personal list gone, yet the account itself somehow still there — would
be a genuinely confusing state to leave behind.

Two safety checks the route itself adds that the existing disable
route doesn't have, checked directly and found genuinely absent before
adding these here rather than assumed present: can't remove your own
account, and can't remove the last remaining `Administrators` member
— both irreversible-lockout scenarios disable's own reversibility
never had to guard against.

**A real, pre-existing limitation surfaced while building this, not
introduced by it**: this app issues stateless JWTs, and
`middleware/requireAuth.ts` verifies a token's own signature and
expiry only — checked directly against that file's actual code, not
assumed — it never re-queries the database to confirm the account
still exists or isn't disabled. An already-issued, still-unexpired
token therefore keeps authenticating for up to
`SESSION_ABSOLUTE_MAX_HOURS` after either a disable or a remove,
though in practice most routes' own separate permission lookups
against the now-absent or disabled `user_id` would find nothing to
match. Properly closing this would mean adding some form of
server-side session tracking — a genuine, separate architectural
decision, deliberately not folded in silently as a side effect of this
feature; flagged in `TODO.md` instead.

**Verification, the same real-`tsc` technique established
in Section 16's own AD-cert work**: no real Postgres instance was
available in this environment either (the same broader
`apt`/`npm` registry block, not specific to Postgres), so migration
023's own SQL is checked carefully by hand and by direct analogy to
already-proven syntax (migrations 021/022), not independently
confirmed against a live database — flagged plainly, not glossed over.
The real TypeScript compiler, already installed globally and
unaffected by the registry block, was run directly against every
changed file, filtering only the errors this specific,
`node_modules`-less invocation could never avoid; zero errors of any
other kind. `removeUser`'s own actual logic — not just its types — was
separately, genuinely run via the same stripped-to-plain-JS-plus-a-
real-stateful-mock technique used throughout this project's own AD
work: a full removal (personal list gone, shared list surviving,
username snapshotted onto that account's own audit rows, an unrelated
account's own audit rows completely untouched) and a second call
against an already-removed account (a safe no-op, not a thrown error),
both genuinely executed and passing.

---

## 18. Where to look next

- **`TODO.md`** — the living, actively-maintained list of what's still
  open, what's a deliberate simplification vs. a real gap, and what's been
  closed (with enough detail to avoid re-investigating).
- **`docs/TESTING_PLAN.md`** — the testing strategy in full, including
  exactly what's blocked on Docker and what the first concrete action
  should be once it's available.
- **`docs/ARCHITECTURE.md`** — the short-form version of Sections 3
  through 5 above.
