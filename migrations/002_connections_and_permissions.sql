-- Connection lists, individual connections, group/user permissions, vaulted credentials
CREATE TABLE connection_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    schema_version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id UUID NOT NULL REFERENCES connection_lists(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL CHECK (protocol IN ('rdp','vnc','ssh','telnet','kubernetes')),
    hostname TEXT NOT NULL,
    port INT NOT NULL,
    credential_mode TEXT NOT NULL CHECK (credential_mode IN ('shared','individual')),
    force_record BOOLEAN NOT NULL DEFAULT false,
    params JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_connections_list_id ON connections(list_id);

-- Split into two tables (rather than a polymorphic principal_id) for real FK integrity
CREATE TABLE list_user_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id UUID NOT NULL REFERENCES connection_lists(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('view','connect','edit','admin')),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (list_id, user_id, permission)
);

CREATE TABLE list_group_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id UUID NOT NULL REFERENCES connection_lists(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('view','connect','edit','admin')),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (list_id, group_id, permission)
);

CREATE INDEX idx_list_user_permissions_lookup ON list_user_permissions(list_id, user_id);
CREATE INDEX idx_list_group_permissions_lookup ON list_group_permissions(list_id, group_id);

-- Credentials: only ciphertext (Vault Transit output) ever lands here, never plaintext
CREATE TABLE connection_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- NULL for 'shared' mode
    username_encrypted TEXT NOT NULL,
    secret_encrypted TEXT NOT NULL, -- Vault Transit ciphertext, e.g. "vault:v1:...."
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (connection_id, user_id)
);
