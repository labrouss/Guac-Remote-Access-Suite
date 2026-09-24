-- Live sessions, sharing/presence, recordings + video export, audit trail
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES connections(id),
    owner_user_id UUID NOT NULL REFERENCES users(id),
    guacd_connection_id TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ
);

CREATE TABLE session_participants (
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('owner','viewer','interactive')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at TIMESTAMPTZ,
    PRIMARY KEY (session_id, user_id, joined_at)
);

CREATE TABLE session_recordings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES connections(id),
    user_id UUID NOT NULL REFERENCES users(id), -- who pressed record
    file_path TEXT NOT NULL,
    file_size_bytes BIGINT,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    video_path TEXT,
    video_encoded_at TIMESTAMPTZ,
    video_size_bytes BIGINT,
    export_status TEXT CHECK (export_status IN ('none','processing','completed','failed')) DEFAULT 'none'
);

CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    connection_id UUID REFERENCES connections(id),
    action TEXT NOT NULL, -- 'connect','share_created','list_exported','credential_updated','record_start', etc.
    detail JSONB,
    source_ip INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX idx_audit_log_connection_id ON audit_log(connection_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);
