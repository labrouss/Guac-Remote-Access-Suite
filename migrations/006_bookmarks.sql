-- Bookmarks: plain URLs a user wants quick access to, distinct from Guacamole
-- connections (no protocol/hostname/credentials — just opens in a new tab).
-- Lives inside the same connection_lists "folder", so the existing
-- list_user_permissions / list_group_permissions grants apply to bookmarks too.
CREATE TABLE bookmarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id UUID NOT NULL REFERENCES connection_lists(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon_url TEXT, -- optional favicon override; falls back to the browser's own favicon fetch
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookmarks_list_id ON bookmarks(list_id);
