# TODO / Open Ends

Living reference for what's still outstanding. Update this file whenever an
item is closed or a new gap is found. Historical detail on past rounds,
resolved bugs, and design decisions lives in `techdetails.md` and in the
code's own comments (each real bug found along the way is documented right
at the fix itself), not duplicated here — this file tracks only what's
still actually open, kept current rather than accumulating a long back-log
of resolved items.

## Genuinely open

### SSH connection to a storage array with a restricted proprietary CLI — a known guacd/libssh2 limitation, not a bug in this app
- [ ] An SSH connection to a storage array's own management CLI, working
      fine from a plain SSH client, fails through the app. Confirmed via
      real guacd logs that authentication genuinely succeeds and the
      session ends almost immediately after — not a credential problem.
      The array runs a proprietary, TCL-based CLI that appears to treat
      any unrecognized input as connection-ending, not just an error —
      matches a known, closed-as-"Not A Bug" upstream Guacamole report
      (GUACAMOLE-703) for the same class of restricted shell. Not
      fixable in this app's own code either way — the SSH protocol
      handling happens entirely inside guacd, a third-party binary this
      app doesn't modify. Workarounds not yet tried: SSH to a standard
      jump host through the app first, then to the array from there; or
      proxy the array's own web console instead, if it has one, via this
      app's own bookmark proxy.

### MP4 session-recording export — queued but never processed
- [ ] `POST /api/sessions/recordings/:id/export` queues a BullMQ job
      that no worker anywhere in the codebase processes — calling it
      currently does nothing observable, forever. Authorization for this
      and the related `/status`/`stream`/`DELETE` endpoints was fixed
      long ago; this item is now purely about the missing
      worker. Either build one (needs an encoder available in the
      deployment, e.g. `ffmpeg` or Guacamole's own `guacenc`) or remove
      the half-built path until it's actually wanted.

### Third-party dependency bug: guacamole-common-js@1.5.0's Blob-source recording playback is broken
- [ ] Confirmed directly against the real installed library:
      `Guacamole.SessionRecording`'s `Blob`-source constructor path
      never assigns its `source` parameter to the internal variable it
      immediately tries to parse, so it always throws. Confirmed fixed
      in Apache's own current upstream source, but 1.5.0 is still the
      newest version published to npm. `RecordingPlayer.tsx` works
      around this via the library's `Tunnel`-source path instead (see
      that file's own comment for the full explanation and how the
      workaround itself was verified). Worth revisiting if/when a newer
      `guacamole-common-js` ever ships with the fix — the workaround
      could likely simplify back to the library's own documented,
      straightforward `Blob`-source form.

### Runtime verification — what's genuinely been run for real, and what hasn't
- [ ] **No literal Docker daemon has ever been available in any
      environment this project has been worked in, including now** — so
      a full `docker compose up` of the actual, real multi-container
      stack has never been run end to end by this assistant. This is a
      real, standing gap, not resolved by anything below. What HAS
      genuinely been verified, directly, with real software rather than
      mocks or static analysis alone, across many separate rounds: a
      real Postgres server (migrations applied and inspected directly);
      a real Caddy binary (TLS handshakes, on-demand certificate
      issuance, `!reset` YAML-merge behavior); a real `docker compose`
      CLI binary, multiple versions, for compose file merge/validation
      semantics specifically; real `ldapts` LDAP client behavior against
      a hand-built mock server, including the RFC-4513 empty-password
      bind bypass; real `react-dom` rendering with genuine DOM events
      (not just `react-test-renderer`, which gave a false negative on
      one real interaction once); real `argon2` hashing. The gap that
      remains is specifically the full stack wired together and started
      as one unit — individual pieces have had substantial, genuine,
      non-mocked verification. Confirmed working end-to-end by the
      person actually running it, across many real deployments —
      audio, touch input, file transfer, downloads, and more all
      confirmed genuinely working on real hardware/VMs.
- [ ] Vault's AppRole token-refresh logic (`services/vaultClient.ts`,
      `getVaultToken`) has never been exercised against a real, running
      Vault instance by this assistant — only read, and covered by a
      mocked unit test using `vi.useFakeTimers()` to simulate lease
      expiry, not a genuine Vault server's own behavior.
- [ ] The Buildroot appliance (`buildroot/`) has never been built or
      booted by this assistant — no Buildroot toolchain, kernel source,
      or VMware/QEMU environment has been available in this assistant's
      own environment at any point. Every config symbol was checked
      against real Buildroot source, but the actual build/boot/
      OVA-import sequence remains unverified by this assistant. See
      `buildroot/README.md`'s own "Verification status" section for
      specifics.
- [~] End-to-end tests (Playwright) — scaffolded, never executed by this
      assistant, same Docker-availability gap as above.
      `docker-compose.test.yml` (a throwaway stack), `e2e/vault-init.sh`,
      and `e2e/tests/full-journey.spec.ts` (4 of 7 target flows fully
      scripted, 3 left as honest `test.fixme()` stubs) all exist and
      type-check, wired into `ci.yml` behind `continue-on-error: true`
      jobs ready for a Docker-equipped CI runner, but none of it has
      actually been run by this assistant. See `docs/TESTING_PLAN.md`'s
      Layer 3 section.
- [~] Backend integration tests (`backend/tests-integration/`) — same
      status: five files, a real-Postgres `testcontainers` harness, all
      type-checked, none ever executed by this assistant (same Docker
      gap). See `docs/TESTING_PLAN.md`'s Layer 2 section.
- [ ] A working `npm install` has never succeeded in this assistant's
      own environment (a persistent registry 403), so `tsc --noEmit` and
      `vitest run` have never been run through the project's own,
      real npm scripts either — verified instead throughout via a
      globally-installed `tsc` binary (unaffected by the registry
      block) run directly against changed files, filtering only the
      expected `node_modules`-less noise (missing `@types/node`,
      unresolved `react`/`guacamole-common-js`/etc.), plus hand-built,
      real-logic test harnesses for anything that needed genuine
      runtime behavior rather than just types. A real, standing
      limitation of this: any type only declared by a package's own
      `@types` bundle, and not exercised by one of those hand-built
      harnesses, can't be fully validated this way — this has already
      caught at least one real build failure only visible with the
      actual, installed `@types` package (`Guacamole.AudioContextFactory`,
      not declared by the published `@types/guacamole-common-js` even
      though the real library has it). Worth a full, real
      `npm install && npm run build && vitest run` pass across both
      `frontend/` and `backend/` before trusting this fully.

### Frontend component testing — real, but not comprehensive
- [ ] Real `react-dom` component-level testing was demonstrated and
      actually run once, on `UserMenu.tsx` — genuine DOM rendering,
      genuine event dispatch, not mocked — which is what caught a real
      interaction bug `react-test-renderer` alone missed. That's one
      component, not a suite: no other frontend component has
      equivalent coverage yet. The pattern exists and is proven to work
      in this environment; extending it to other components is still
      open.

### Deliberate design limitations (not bugs, still worth knowing about)
- [ ] No email-based password reset. Current flow is admin-initiated
      reset + forced change-password on next login — avoids an SMTP
      dependency, not an oversight — worth revisiting if self-service
      reset becomes a real requirement.
- [ ] Live session sharing's `guacamole-lite` `sessionRegistry` isn't
      configured for horizontal scaling — the default in-memory `Map`
      is correct for this app's default single-backend-replica
      deployment; joining a session across two different backend
      containers behind a load balancer would need a shared registry
      (e.g. Redis-backed) instead. See `techdetails.md` Section 8.
- [ ] Syslog forwarding has no delivery confirmation/retry — UDP is
      fire-and-forget by design (a dropped audit event shouldn't block
      or fail a request); Postgres remains the durable record
      regardless, so no audit data is actually lost, just not forwarded
      during a syslog-server outage window.
- [ ] SSH remote-to-local file transfer isn't available — SSH has no
      equivalent of RDP's own virtual drive. The closest realistic
      option, not yet built: watching a well-known remote folder over
      SFTP, the same way the RDP drive already works. See README.md's
      "File transfer" section.
- [ ] Unmute (audio-resume fallback button) is only shown for a
      session's own owner, matching Record/Share's existing owner-only
      scope in the toolbar — not yet extended to a joined, shared
      session's own viewers.
