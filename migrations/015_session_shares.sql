-- Grants for live session co-viewing/co-control ("share my currently open
-- session with someone"), distinct from session_participants (which is a
-- join/leave EVENT ledger — who actually connected and when, not who's
-- allowed to). A share grant is inherently tied to one specific active
-- session instance, not a standing permission across future sessions on
-- the same connection — cascades away when the session row does.
CREATE TABLE session_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    granted_to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_by_user_id UUID NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('viewer', 'interactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, granted_to_user_id)
);

CREATE INDEX idx_session_shares_granted_to ON session_shares(granted_to_user_id);

-- Speeds up "find my currently active session for this connection" (used
-- to recover the real sessions.id after connecting, and to look up a
-- session to share) — a partial index since only the ended_at IS NULL
-- rows are ever queried this way.
CREATE INDEX idx_sessions_active_owner_connection
    ON sessions(owner_user_id, connection_id) WHERE ended_at IS NULL;
