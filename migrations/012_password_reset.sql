-- Set true whenever an admin resets a user's password (see admin.ts
-- /users/:id/reset-password) and cleared the next time the user
-- successfully changes their own password. Surfaced in the login response
-- so the frontend can force a change-password prompt before the normal app.
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
