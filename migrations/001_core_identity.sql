-- Core identity: users, groups, membership
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret_encrypted TEXT,
    totp_enabled BOOLEAN NOT NULL DEFAULT false,
    webauthn_credentials JSONB DEFAULT '[]',
    active_theme_id UUID, -- FK added in 004_theming.sql after themes table exists
    preferences JSONB NOT NULL DEFAULT '{}', -- panel pinned state, etc.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    disabled_at TIMESTAMPTZ
);

CREATE TABLE groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_groups (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
);

-- Seeded so the first-time setup wizard can attach the initial admin to a real group
INSERT INTO groups (name, description)
VALUES ('Administrators', 'Full administrative access to all connections and system settings');
