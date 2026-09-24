-- Active Directory integration, requested directly and scoped specifically
-- to what was asked for: AD-group-gated login (only members of one
-- configured AD group can sign in at all), plus an optional per-connection
-- mode where a user's own AD credentials are used directly for the RDP/SSH
-- session instead of a separately-stored one. Deliberately NOT a full
-- AD-group-to-this-app's-own-groups sync — that was a real, different
-- option this request considered and didn't ask for; local `groups`
-- membership for AD-authenticated accounts is still assigned the same
-- manual way it already is for everyone else.

-- users.password_hash was NOT NULL — an AD-authenticated account has no
-- local password at all (verified against AD itself on every login, not
-- cached here), so this has to become nullable rather than storing some
-- placeholder value that would misleadingly suggest a real local password
-- exists.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Explicit and checked, not inferred from password_hash being NULL —
-- makes "should this login attempt even look at password_hash, or go to
-- AD instead" a single, unambiguous column read rather than a null-check
-- that would also silently match any future NULL introduced by mistake.
ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'
    CHECK (auth_source IN ('local', 'ad'));

-- A connection's own credential_mode gains a third value: 'ad_passthrough'
-- means neither a shared nor an individual stored credential is used at
-- all — the signed-in user's own AD credentials (see
-- ad_passthrough_credentials below) are used for that connection's own
-- session directly. connection_credentials (migration 002) is untouched:
-- an ad_passthrough connection simply never has a row there, the same as
-- an individual connection nobody has set their own credential on yet.
ALTER TABLE connections DROP CONSTRAINT connections_credential_mode_check;
ALTER TABLE connections ADD CONSTRAINT connections_credential_mode_check
    CHECK (credential_mode IN ('shared', 'individual', 'ad_passthrough'));

-- Deliberately its own table, not new columns on `users` — this is
-- ephemeral, session-scoped secret material (the plaintext AD password,
-- captured only long enough to actually open an ad_passthrough RDP/SSH
-- session with it, Vault-encrypted the same way connection_credentials
-- already is, at rest), not permanent account data; keeping it separate
-- makes "clear every one of these older than the session-idle window" a
-- clean, standalone cleanup query against one small table, not a
-- conditional UPDATE against the core users table mixing permanent and
-- ephemeral concerns in the same row.
CREATE TABLE ad_passthrough_credentials (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- The AD-qualified username (e.g. DOMAIN\username or
    -- user@domain.example.com — whichever form RDP's own NLA actually
    -- needs against the target host), which may genuinely differ from
    -- this app's own users.username depending on how AD_USER_FILTER is
    -- configured — stored separately rather than assumed identical.
    ad_username_encrypted TEXT NOT NULL,
    ad_password_encrypted TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set to this same login's own session-idle deadline (see
    -- services/sessionToken.ts's SESSION_IDLE_TIMEOUT_MINUTES) at write
    -- time, not recomputed later — this table's own row for a user
    -- should stop being usable at the same moment their app session
    -- itself would, not on some separately-tracked clock.
    expires_at TIMESTAMPTZ NOT NULL
);
