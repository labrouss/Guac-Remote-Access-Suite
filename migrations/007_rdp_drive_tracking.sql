-- Tracks the per-session RDP drive-redirection folder so the paste-file and
-- pending-download routes can find the right mount for an active session.
ALTER TABLE sessions ADD COLUMN rdp_drive_id UUID;
