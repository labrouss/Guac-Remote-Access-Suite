# Testing Plan

## Current state (honest baseline)

- **Unit tests**: thirteen files, 136 tests total, all passing:
  - `backend/src/services/permissions.test.ts` (14 tests) — permission-ranking
    and demo-access-expiry logic, mocked `db`.
  - `backend/src/services/guacTunnel.test.ts` (3 tests) — what's actually
    left in this module after live session sharing moved its real
    authorization work elsewhere (see below): a token-freshness check,
    the one thing safe to keep in a guacamole-lite callback, since it
    needs no database or network access. Exercises it through a minimal
    fake `GuacamoleLite` constructor capture rather than exporting an
    internal-only function purely for testability.
  - `backend/src/services/bookmarkProxy.test.ts` (15 tests) — the
    cookie/token pure functions (`verifyProxySessionToken`,
    `extractProxyCookieFromRawHeader`). No mocking needed — these use the
    real `jsonwebtoken` library directly, including a genuine expired-token
    case and a genuinely forged token (signed with a different secret).
  - `backend/src/services/vaultClient.test.ts` (12 tests) — AppRole token
    caching/refresh (via `vi.useFakeTimers()` to genuinely advance past the
    lease-expiry point), plus encrypt/decrypt request-shape checks. Uses
    `vi.resetModules()` + dynamic `import()` per test, since the token
    cache is module-level mutable state.
  - `backend/src/routes/credentials.test.ts` (13 tests) — the
    shared-vs-individual credential write/status branching. Directly
    asserts the exact bound SQL parameters for both credential modes — a
    shared-mode write is checked to bind `null` for `user_id`, not the
    writer's own id.
  - `backend/src/routes/demos.test.ts` (16 tests) — the ownership gate
    (`isOwner`), the resolved-view logic (`getResolvedDemoView`: owner
    bypass short-circuits the grant lookup entirely, non-owner grant
    checking, expiry-clause presence pinned via a SQL-text assertion,
    deleted-item filtering, zero-items short-circuit avoiding empty `IN
    (...)` queries), and the add-item authorization chain (`addDemoItem`:
    owner-only, valid item type, item must exist, owner must have at least
    `view` on the item's own source list before curating it into a demo).
  - `backend/src/services/syslogForwarder.test.ts` (18 tests) — RFC 5424
    message formatting (PRI computation across facility/severity
    combinations, ISO timestamp, app-name/msgId placement, exact message
    body preservation including embedded JSON) and `sendSyslogMessage`'s
    dispatch logic (a disabled config sends nothing — no socket even
    created — and a UDP socket is created, sent to, and closed correctly),
    with `dgram` mocked so no real network is touched.
  - `backend/src/services/auditLog.test.ts` (7 tests) — the centralized
    audit service: correct 5-column Postgres write shape including
    `source_ip` (declared in the schema since the first migration, never
    once populated anywhere before this pass), syslog forwarding correctly
    gated on `SYSLOG_ENABLED`, and `logAuditFromRequest`'s automatic
    `userId`/`req.ip` extraction — including the no-authenticated-user case
    resolving to `null` rather than throwing.
  - `backend/src/services/csrf.test.ts` (8 tests) — the double-submit CSRF
    token used by the setup wizard's session-cookie flow: token
    generation/reuse, and every rejection path for `requireCsrfToken`
    (missing session token, missing header, mismatched value, and a
    case-sensitivity check confirming no accidental loose matching).
  - `backend/src/services/guacToken.test.ts` (4 tests) — the
    guacamole-lite-compatible token encryption, verified by round-tripping
    through a reference decrypt implementation matching the real
    library's algorithm exactly (not imported from the library's internal,
    non-public-API file path). Written after discovering the app's
    previous token format didn't actually match what guacamole-lite 1.2.0
    decrypts — this is what would have caught that immediately.
  - `backend/src/routes/tunnelToken.test.ts` (9 tests) — the full
    authorization + credential-decryption + RDP-drive-setup +
    token-construction logic for opening a new connection
    (`issueNewConnectionToken`), extracted here after an empirically-found
    race made doing this work inside a guacamole-lite callback unsafe (see
    the Layer 1 section below). Covers connection-not-found/not-authorized
    /no-credentials short-circuits, individual-vs-shared credential
    scoping, RDP-only drive setup, and that the returned token actually
    carries the fully-resolved connection settings guacd needs.
  - `backend/src/routes/sessions.test.ts` (9 tests) — `issueJoinToken`, the
    authorization logic for joining an active shared session: owner
    always authorized with no share-table lookup at all, a valid share
    grant, a missing grant rejected, an ended/nonexistent session
    rejected, and the narrow race where a session exists but its real
    guacd connection ID isn't populated yet.
  - `backend/src/middleware/requireSetup.test.ts` (8 tests) — the
    first-time-setup gate, across all three real mount points it's reused
    on (`/api/setup`, `/api`, `/proxy`). Found and fixed a real production
    bug while writing this: the middleware used `req.path`, which Express
    strips to be relative to whichever `app.use(prefix, ...)` mount
    invoked it — meaning `/api/setup/status` itself (mounted under
    `/api/setup`) was incorrectly evaluated as not starting with
    `/api/setup`, circularly blocking the one endpoint whose job is
    reporting setup status. Confirmed the test suite actually catches this
    class of bug, not just passes trivially: reverted to the original
    `req.path`-based code, verified 4 of 8 tests genuinely failed, then
    restored the `req.originalUrl`-based fix and confirmed all 8 pass.
  All run via `vitest`, wired into `.github/workflows/ci.yml`.

This completes every item on this plan's original Layer 1 priority list
(authorization logic, credential handling, the guacd tunnel's auth gate,
the bookmark proxy's token layer, and demos' ownership/grant logic), plus
the audit-logging/syslog and live-session-sharing work added afterward.
See "Next concrete step" below for where testing effort goes now.
- **Integration tests (Layer 2)**: five files drafted
  (`backend/tests-integration/*.integration.test.ts`) covering the setup
  wizard, login flow, list permissions, demo access + expiry, and the
  credential write path, backed by a real-Postgres harness
  (`tests-integration/harness.ts`) using `testcontainers`. All five files
  type-check — genuinely confirmed via `--listFilesOnly` after catching a
  false-positive from an inherited `tsconfig` exclude, not just trusted
  from an exit code (see the Layer 2 section below for that story in
  full). **None of them have actually been run** — no Docker daemon has
  been available in this environment to execute them.
- **End-to-end tests (Layer 3)**: scaffolded — `docker-compose.test.yml`
  (a throwaway stack with a disposable SSH target and a static internal
  test page), `e2e/vault-init.sh` (bootstraps dev-mode Vault's Transit
  engine + a fully deterministic AppRole), and a single Playwright journey
  (`e2e/tests/full-journey.spec.ts`) covering four of the plan's original
  seven target flows fully, with the remaining three left as honest
  `test.fixme()` stubs rather than faked passes. Also unexecuted.
- **Type/build verification**: `tsc --noEmit` passes clean on backend,
  frontend, and guac-worker. Frontend has a real `vite build` verified to
  succeed. None of this is "testing" in the behavioral sense — it only
  proves the code compiles and bundles, not that it's correct.
- **Everything else**: unverified except by manual code reading, which
  this project's own history shows is unreliable (see `TODO.md`'s closing
  note — a missing dependency, a silently-broken test file, and a wrong API
  assumption all passed code review before being caught by actually running
  the tools).

## Strategy: prioritize by blast radius, not by ease

The instinct is to write tests for whatever's easiest to test (pure
functions, isolated modules). That's backwards for this project — the
highest-risk code is the *hardest* to test (the guacd tunnel, the bookmark
proxy, session recording), because it's exactly the code most entangled
with external state (child processes, WebSockets, the filesystem). Easy
tests are still worth having, but they shouldn't crowd out coverage of the
things that would actually hurt in production if they silently broke.

Rough priority order, based on "what breaks quietly and expensively":

1. **Authorization logic** — already the best-covered area
   (`permissions.test.ts`), and rightly so: a bug here means someone sees or
   touches something they shouldn't, silently. Extend this before anything
   else.
2. **Credential handling** — ✅ fully covered: Vault encrypt/decrypt request
   shaping and token caching/refresh (12 tests), plus the credentials.ts
   write-path branching itself (13 tests, see above).
3. **The guacd tunnel's authorization gate** — ✅ covered, though the logic
   has since moved. Originally `services/guacTunnel.ts:resolveConnectionSettings`
   (10 tests); after live session sharing required upgrading
   `guacamole-lite` to 1.2.0, an empirically-found race meant real
   authorization work could no longer safely live in that callback (see
   `TODO.md`'s live-session-sharing entry for the full story) — moved to
   `routes/tunnelToken.ts:issueNewConnectionToken` (9 tests) and
   `routes/sessions.ts:issueJoinToken` (9 tests). Was, and remains, the one
   place that decides whether a connection attempt is actually allowed
   before guacd ever sees it; previously had zero test coverage despite
   being the single most security-critical function in the codebase.
4. **Bookmark proxy access checks** — the cookie/token layer is now covered
   (15 tests, see above). Still open: the route-level checks in
   `routes/bookmarkProxy.ts` itself (`resolveProxyTarget`,
   `attachBookmarkProxyWebsockets`) aren't unit tested yet — they're mostly
   Express/upgrade-event plumbing around the now-tested pure functions, which
   pushes them toward the integration-test layer rather than unit tests (see
   Layer 2 below).
5. **Demo access + expiry** — ✅ fully covered: `permissions.test.ts` for
   the underlying expiry logic, `demos.test.ts` (16 tests) for the
   ownership gate, resolved-view owner-bypass/grant/deleted-item logic, and
   the add-item authorization chain.
6. **Everything else** (setup wizard, admin CRUD, recording lifecycle) —
   lower urgency; failures here are visible and annoying, not silent and
   dangerous.

## Layer 1: Unit tests (vitest, mocked `db`)

This project's own priority list is now fully done:

- ~~`services/bookmarkProxy.ts` pure functions~~ — done, see
  `bookmarkProxy.test.ts` (15 tests)
- ~~`services/guacTunnel.ts` authorization gate~~ — done, see
  `guacTunnel.test.ts` (10 tests)
- ~~`services/vaultClient.ts` token caching/refresh~~ — done, see
  `vaultClient.test.ts` (12 tests)
- ~~`routes/credentials.ts` shared-vs-individual branching~~ — done, see
  `credentials.test.ts` (13 tests)
- ~~`routes/demos.ts` ownership gate, resolved-view logic, add-item
  authorization~~ — done, see `demos.test.ts` (16 tests)

80 tests total, all genuinely run and passing. Further Layer 1 additions
are welcome as new code is written, but there's no remaining backlog item
from this plan's original blast-radius ordering — see "Next concrete step"
below for where effort goes now.

## Layer 2: Integration tests (real Postgres, real HTTP, mocked Vault/guacd)

**Status: drafted, never executed.** Five test files exist and type-check
genuinely (see the note on how that was actually verified, below), but no
Docker daemon has been available anywhere in this project's history to run
them against a real Postgres container. Treat everything in this section
as a starting point for whoever has Docker access next, not proven-working
code.

**What's built:**

- `backend/src/app.ts` — the Express app construction split out of
  `server.ts` (no port binding, no WebSocket upgrade wiring), so
  `supertest(createApp())` can mount the real app directly. `server.ts`
  now just imports `createApp()` and adds the `httpServer`/WebSocket/listen
  side effects on top. Verified this refactor compiles clean and all 80
  Layer 1 tests still pass afterward.
- `backend/src/migrationRunner.ts` — the migration-applying logic extracted
  out of `scripts/migrate.ts` into a reusable `applyMigrations(db, dir)`
  function, so integration tests run the *exact same* migration chain
  production does, not a parallel reimplementation that could silently
  drift from it.
- `backend/tests-integration/harness.ts` — starts a real Postgres via
  `@testcontainers/postgresql`, points `process.env.POSTGRES_*` at it,
  applies migrations, and exposes `createTestApp()` (a fresh
  `createApp()` import, since `db.ts` reads its config from `process.env`
  at import time) plus `installMockVaultFetch()` (mocks Vault's Transit
  encrypt/decrypt and AppRole login at the `node-fetch` boundary — per this
  plan's own stance, guacd and Vault stay mocked even at this layer). The
  testcontainers API used here (`getHost()`, `getPort()`, `getDatabase()`,
  etc.) was verified directly against the installed package's `.d.ts`
  files, not assumed from memory.
- Five drafted test files, one per target flow from the original plan
  (all in `backend/tests-integration/*.integration.test.ts`):
  - **`setupWizard.integration.test.ts`** — admin creation → TOTP
    enrollment → verification → Vault check → completion → confirms
    `/api/setup` returns 410 afterward. Computes a genuinely valid TOTP
    code via `otplib.authenticator.generate()` using the real secret
    extracted from the enrollment response's `otpauth://` URL, rather than
    faking the verification step.
  - **`loginFlow.integration.test.ts`** — wrong username/password (generic
    error, no enumeration signal), TOTP challenge round-trip, a working
    session token proven against a real `requireAuth`-gated route (not just
    "the login endpoint returned something"), and rate-limit triggering
    after 11 failed attempts (exercises `express-rate-limit`'s real
    in-memory state, which a mocked-db unit test can't touch at all).
  - **`listPermissions.integration.test.ts`** — an unrelated user gets 403
    throughout; a `view`-only grant can list connections but can't obtain a
    connect token; upgrading to `connect` unlocks the tunnel-token route.
  - **`demoAccess.integration.test.ts`** — owner curates an item, a granted
    user sees exactly that item with zero access to the parent list, an
    already-past `expiresAt` is rejected immediately, and revocation works
    the same way. Documents an important nuance in-file: Postgres's `now()`
    is evaluated by the database server, not Node, so `vi.useFakeTimers()`
    can't be used to test expiry here — the test grants an already-expired
    timestamp instead.
  - **`credentialWritePath.integration.test.ts`** — queries
    `connection_credentials` directly via the same `db` singleton the app
    uses, confirming the actual persisted row shape (individual mode scopes
    `user_id`, shared mode is genuinely `NULL`) rather than only asserting
    intended SQL parameters the way `credentials.test.ts` does.

**A verification near-miss worth recording:** while confirming these files
at least type-check, a separate `tsconfig.test.json` was added
(`extends` the main config, adds `tests-integration` to `include`). The
first run reported a clean exit code — but that was a false positive:
TypeScript was silently inheriting the main `tsconfig.json`'s `exclude`
(added in this same pass, to keep `*.test.ts` out of the production
`dist/` build), so zero integration-test files were actually being
type-checked at all. Caught by cross-checking with `--listFilesOnly`
before trusting the exit code, then fixed with an explicit
`"exclude": []` override in `tsconfig.test.json`. This is exactly the same
"looks done but isn't" trap this project has hit before — recorded here
because it's a pattern worth remembering, not a one-off mistake.

**Not yet done:**

```
npm install --save-dev testcontainers @testcontainers/postgresql supertest @types/supertest
```
(already run; these are in `backend/package.json`'s devDependencies now).

Running `npm run test:integration` for the first time against a real
Docker daemon — everything above is unexecuted until that happens.

## Layer 3: End-to-end (Playwright, against a real running stack)

**Status: scaffolded, never executed.** This layer would have caught the
Mouse-API bug and the missing `express-session` dependency immediately,
rather than requiring a manual "actually run the compiler" pass — but
everything below is drafted, not proven.

**What's built:**

- `docker-compose.test.yml` — a throwaway stack separate from
  `docker-compose.dev.yml`/`docker-compose.prod.yml`: fresh `tmpfs`
  Postgres, dev-mode Vault, a disposable SSH target
  (`linuxserver/openssh-server`) for the terminal-rendering test, and a
  static nginx container (`internal-test-http`, serving
  `e2e/fixtures/internal-page.html`) standing in for an internal-only host
  the browser can't reach directly but the backend can — exactly what the
  proxied-bookmark test needs to prove the proxy path actually works, not
  just that a direct bookmark does. Validated structurally the same way
  the dev/prod compose files were earlier (no dangling `depends_on`, all
  referenced volumes declared, all `env_file`/bind-mount paths exist).
- `e2e/vault-init.sh` — dev-mode Vault auto-unseals but starts with no
  Transit engine, no AppRole auth method, and no role configured; this
  bootstraps both, using Vault's `custom-secret-id` endpoint (and an
  explicit `role_id` parameter on role creation) so both halves of the
  AppRole credential are fully deterministic — fixed values known ahead of
  time in `e2e/.env.test`, not read back from Vault at runtime. Worth
  noting explicitly: an earlier draft of this script only fixed
  `secret_id` and left `role_id` as "should match, unconfirmed"; realized
  while writing it that `role_id` can be pinned the exact same way, so
  fixed that rather than shipping the weaker version. Syntax-checked with
  `sh -n` (the one thing checkable about a shell script without actually
  running it).
- `e2e/playwright.config.ts` + `e2e/tests/full-journey.spec.ts` — a single
  `test.describe.serial()` file (not seven independent tests) covering all
  seven flows from this plan's original minimum-viable list, since they
  genuinely share state (one setup wizard run produces the one admin
  account every later step depends on). Selectors were written against the
  real component source (`SetupWizard.tsx`, `LoginPage.tsx`,
  `ConnectionPanel.tsx`, `BookmarkPanel.tsx`, `MainApp.tsx`,
  `DemoPanel.tsx`) — actual label text, button text, class names — rather
  than guessed. Steps 1-4 are fully scripted; **steps 5-7 are marked
  `test.fixme()` with an explanation, not faked** — SSH connection creation
  via the admin UI, credential assignment, and second-user demo-grant
  verification aren't wired into the journey yet. Both files type-check,
  confirmed via `--listFilesOnly` (not just exit code, per the lesson from
  Layer 2's false positive — see `TODO.md`).
- `.github/workflows/ci.yml` — two new jobs, `backend-integration-tests`
  and `e2e-tests`, both `continue-on-error: true` since neither has ever
  actually run. GitHub Actions' standard Ubuntu runners have Docker
  pre-installed, so these have a real chance of working the first time
  they're pushed — unlike this development environment, which has never
  had Docker available at all.

**Known incomplete, by design, not oversight:**

- Steps 5 (SSH terminal), 6 (recording), and 7 (demo grant verification)
  in `full-journey.spec.ts` are `test.fixme()` stubs. Completing them
  needs the admin panel's connection-creation and user-creation flows
  scripted via the UI (currently only steps 1-4 exercise the UI directly;
  a real completion would extend the same journey rather than starting a
  new file).

## Blocking on Docker

Layer 2's five test files and Layer 3's scaffolding (compose stack, Vault
bootstrap, Playwright journey) are both now drafted (see above) but
genuinely unexecuted. No Docker daemon has been available anywhere in this
project's history to actually run `docker compose up`, `testcontainers`,
or a Playwright browser against a live stack. Concretely, before either
layer can be proven out:

- Run `npm run test:integration` in `backend/` for the first time against
  a real Docker daemon — this is the single next action that would turn
  Layer 2 from "drafted" into "verified." Expect some friction on the
  first run (container image pull time, possible testcontainers API
  surface drift between what was verified against the installed `.d.ts`
  files and actual runtime behavior) — the harness and five test files
  should be treated as a strong starting point, not a guarantee.
- Run `docker compose -f docker-compose.test.yml up -d --build` followed
  by `npm run test:e2e --prefix e2e` — the equivalent first-run test for
  Layer 3. Specific things likely to need adjustment on that first run,
  flagged here rather than assumed away: whether `vault-init.sh`'s fixed
  `role_id`/`secret_id` approach actually works against a real Vault dev
  server (verified against Vault's documented AppRole API surface, not a
  running instance); whether the `linuxserver/openssh-server` image's
  default SSH host key setup is fast enough for the "5. SSH connection"
  step's `test.fixme()` to eventually un-`fixme`; and general first-run
  Playwright selector brittleness (written against component source, not
  a rendered DOM).
- Confirm `testcontainers` and Playwright's browser downloads work in
  whatever CI runner will actually execute them — `ci.yml`'s
  `backend-integration-tests` and `e2e-tests` jobs are already wired up
  with `continue-on-error: true` for exactly this reason; flip that off
  once a real run confirms they pass.

## Manual QA checklist (things not worth automating yet)

Some things are either too expensive to automate given current scope, or
inherently need a human:

- Visual review of the Signal (Dark) theme across the actual app shell,
  setup wizard, and admin panel after any CSS change
- RDP drive-redirection behavior against a *real* Windows target (the
  drive-mount/watch logic is exercised by code review and the retention
  logic is unit-testable, but "does Windows actually see the mounted
  drive" needs a real RDP target)
- guacenc video export producing a genuinely playable `.m4v` file (the
  job-queue logic around it is testable; the actual encoder output isn't,
  without a real guacd + a real recorded session first)
- Vault AppRole login against a real Vault instance, including what
  happens on lease expiry mid-session

## Next concrete step

Every item on this plan's original Layer 1 priority list is done (136 tests,
genuinely run and passing, across twelve files). Layer 2 (real-Postgres integration tests) and
Layer 3 (Playwright e2e against the full stack) are both now drafted —
harness, five integration test files, a throwaway compose stack, a Vault
bootstrap script, and a seven-step (four fully scripted, three honest
`test.fixme()` stubs) browser journey. **None of Layer 2 or Layer 3 has
actually been executed.**

The single next action, unchanged from before, is **running
`npm run test:integration` for the first time against a real Docker
daemon** — it's the smaller, faster, lower-risk of the two unexecuted
layers, and a natural prerequisite: if the Postgres-only integration tests
don't pass, the full browser-plus-every-service e2e stack won't either.
Once that's proven out, `docker compose -f docker-compose.test.yml up -d
--build && npm run test:e2e --prefix e2e` is the equivalent next step for
Layer 3. Everything checkable without Docker — compilation, type-checking
(including catching the tsconfig false-positive along the way), shell
script syntax, compose file structural validation — has been checked.
Whether any of it actually behaves correctly against real infrastructure
has not, and remains the one thing genuinely blocked on this environment's
lack of a Docker daemon.
