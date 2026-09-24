-- Schema support for actually removing a user account (not just
-- disabling one), requested directly. The real design question this
-- raised: several tables reference users(id) with no ON DELETE clause
-- at all (defaulting to RESTRICT), or with ON DELETE CASCADE on a
-- table that's meant to be shared with other people — a plain
-- `DELETE FROM users` would either fail outright the moment the
-- account has ever done anything at all (a single login already
-- creates an audit_log row), or silently destroy compliance-relevant
-- history and other people's access to shared resources. Every change
-- below is deliberately either SET NULL (preserve the historical row,
-- just disassociate it from the now-gone identity) or a narrow CASCADE
-- (remove only what's genuinely private to this one account, nothing
-- anyone else could ever depend on) — never a wholesale cascade of
-- anything shared or audit-relevant.
--
-- Postgres's own standard auto-naming for an unnamed foreign key
-- constraint (`<table>_<column>_fkey`) is relied on below to drop and
-- recreate each one — the same convention already confirmed directly
-- against a real database for a CHECK constraint in an earlier
-- migration's own work, though not independently re-confirmed for a
-- FOREIGN KEY specifically this round (no real Postgres instance was
-- available in this environment to test against here — flagged
-- explicitly in TODO.md, not silently assumed correct).

-- A real, separately-discovered bug, not something this feature
-- introduces: demos are explicitly designed to be shared with other
-- people (demo_grants) independent of who owns the underlying
-- connections — but its own owner_id was ON DELETE CASCADE, meaning
-- removing a demo's owner would have destroyed the whole demo, and
-- every other person's access to it, even though nothing about
-- removing one account should ever affect what a completely different
-- person can see. Checked against the actual route code
-- (routes/demos.ts) before making this change: every ownership check
-- there already compares owner_id to a real user's own id
-- (`demo.owner_id === userId`), which simply never matches a NULL —
-- an orphaned demo safely becomes unmanaged by any one specific
-- person, not broken or inaccessible to its existing viewers.
ALTER TABLE demos ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE demos DROP CONSTRAINT demos_owner_id_fkey;
ALTER TABLE demos ADD CONSTRAINT demos_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;

-- sessions rows are never deleted by this app's own code once created
-- (confirmed directly — no DELETE FROM sessions anywhere in this
-- codebase), so owner_user_id would otherwise block removing anyone
-- who has ever opened even a single connection, forever. SET NULL
-- preserves the session's own historical record (still real
-- audit-adjacent value: which connection, when) without requiring the
-- owning identity to still exist.
ALTER TABLE sessions ALTER COLUMN owner_user_id DROP NOT NULL;
ALTER TABLE sessions DROP CONSTRAINT sessions_owner_user_id_fkey;
ALTER TABLE sessions ADD CONSTRAINT sessions_owner_user_id_fkey
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- session_participants' own user_id is part of its composite primary
-- key (session_id, user_id, joined_at) — Postgres never allows a
-- primary-key column to be NULL under any circumstances, so SET NULL
-- isn't available here the way it is everywhere else in this
-- migration. CASCADE instead: removes only this one person's own
-- join/leave history rows for whichever sessions they took part in —
-- the session itself, and anyone else's own participation rows in it,
-- are untouched either way.
ALTER TABLE session_participants DROP CONSTRAINT session_participants_user_id_fkey;
ALTER TABLE session_participants ADD CONSTRAINT session_participants_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- "who pressed record" preserved deliberately — a session recording is
-- exactly the kind of thing this app's own compliance/audit posture
-- (see the audit-log and syslog-forwarding work elsewhere) exists to
-- keep, regardless of whether the account that made it still exists.
ALTER TABLE session_recordings ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE session_recordings DROP CONSTRAINT session_recordings_user_id_fkey;
ALTER TABLE session_recordings ADD CONSTRAINT session_recordings_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- audit_log.user_id was already nullable but had no ON DELETE clause
-- at all — defaulting to RESTRICT, which would block removing
-- essentially any real account at all, since a single login already
-- writes a row here.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_user_id_fkey;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Deliberately only on audit_log, not every other table touched in
-- this same migration — this is this app's own primary, explicit
-- audit/compliance record (its own admin UI tab, syslog forwarding),
-- not just incidental operational data the way sessions/
-- session_recordings/session_shares are; losing the human-readable
-- "who" the moment user_id above goes to NULL would otherwise
-- meaningfully weaken exactly the record this column exists to keep.
-- Populated once, at removal time (see services/userRemoval.ts), not
-- backfilled for existing rows or written on every new row going
-- forward — nothing needs it until the user_id it would otherwise
-- explain is actually gone.
ALTER TABLE audit_log ADD COLUMN removed_user_username TEXT;

-- Same reasoning as owner_user_id above: a share grant genuinely
-- naming who created it is worth keeping even once that person is
-- gone, and the share itself already, correctly, disappears on its own
-- once the person it was granted TO is removed (granted_to_user_id,
-- untouched here, already CASCADE from its own original migration).
ALTER TABLE session_shares ALTER COLUMN granted_by_user_id DROP NOT NULL;
ALTER TABLE session_shares DROP CONSTRAINT session_shares_granted_by_user_id_fkey;
ALTER TABLE session_shares ADD CONSTRAINT session_shares_granted_by_user_id_fkey
    FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
