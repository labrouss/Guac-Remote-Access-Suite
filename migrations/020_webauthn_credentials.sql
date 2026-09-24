-- Passkey support, requested directly ("like Google and some sites do").
--
-- users.webauthn_credentials (JSONB, from 001_core_identity.sql) is
-- dropped here rather than reused: it's been present since this app's
-- very first migration with zero code anywhere ever reading or writing
-- it — an early placeholder for this exact feature that was never
-- carried through. It also wouldn't have fit the real access pattern
-- this feature actually needs: a usernameless passkey login only has
-- the credential ID from the browser's response, and has to find which
-- user it belongs to *before* it knows who's signing in at all. A JSONB
-- array on users would need a containment scan across every user's own
-- array to answer that; a dedicated table with credential_id UNIQUE and
-- indexed answers it with a single indexed lookup, which is the whole
-- point of a passkey login being fast and "usernameless" in the first
-- place. Left as a genuinely separate table rather than folding
-- credential storage into users for the same reason connection_folders
-- (018) and bookmark_folders (019) are their own tables rather than
-- columns: a user can register more than one passkey (a laptop, a
-- phone, a security key), the same one-to-many shape those two already
-- established a table for rather than a column for.
ALTER TABLE users DROP COLUMN webauthn_credentials;

CREATE TABLE webauthn_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Base64url, exactly as returned by the browser and by
    -- @simplewebauthn/server — this is what a login attempt is looked
    -- up by, before the app knows which user is signing in.
    credential_id TEXT NOT NULL UNIQUE,
    public_key BYTEA NOT NULL,
    -- Signature counter reported by the authenticator, used to detect a
    -- cloned/replayed credential (should only ever increase) — kept as
    -- its own column specifically so it can be updated on every
    -- successful login without touching anything else on the row.
    counter BIGINT NOT NULL DEFAULT 0,
    transports TEXT[],
    -- 'singleDevice' | 'multiDevice', and whether a multiDevice
    -- credential has actually been synced/backed up by the platform
    -- (a passkey in iCloud Keychain or Google Password Manager, vs. one
    -- bound to a single security key) — both reported directly by
    -- @simplewebauthn/server's own verification result, kept for
    -- display in the passkey management UI, not used in any security
    -- decision here.
    device_type TEXT NOT NULL,
    backed_up BOOLEAN NOT NULL DEFAULT false,
    -- User-chosen label ("MacBook Touch ID", "YubiKey") — passkeys
    -- carry no human-readable name of their own, and anyone who
    -- registers more than one needs some way to tell them apart when
    -- deciding which to remove later.
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX idx_webauthn_credentials_user_id ON webauthn_credentials(user_id);
