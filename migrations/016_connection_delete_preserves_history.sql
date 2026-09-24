-- Real bug found live: deleting a connection from the admin panel always
-- failed with a 500. sessions.connection_id and
-- session_recordings.connection_id were both NOT NULL foreign keys to
-- connections(id) with no ON DELETE behavior specified (defaulting to
-- NO ACTION/RESTRICT) — so any connection that had ever actually been
-- used, which is exactly the kind an admin is most likely to want to
-- clean up, could never be deleted at all. audit_log.connection_id had
-- the same RESTRICT problem, just via a nullable column.
--
-- Deliberately NOT fixed with ON DELETE CASCADE, which would silently
-- destroy session history, recordings, and audit trail the moment a
-- connection definition was deleted — a much worse outcome than the bug
-- being fixed, and a serious problem for anyone relying on that history
-- for security or compliance review. ON DELETE SET NULL instead: the
-- connection definition can be removed, but every session, recording,
-- and audit entry that ever referenced it is preserved, just no longer
-- linked to a connection row that no longer exists.

ALTER TABLE sessions ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_connection_id_fkey;
ALTER TABLE sessions
    ADD CONSTRAINT sessions_connection_id_fkey
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE SET NULL;

ALTER TABLE session_recordings ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE session_recordings DROP CONSTRAINT IF EXISTS session_recordings_connection_id_fkey;
ALTER TABLE session_recordings
    ADD CONSTRAINT session_recordings_connection_id_fkey
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE SET NULL;

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_connection_id_fkey;
ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_connection_id_fkey
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE SET NULL;
