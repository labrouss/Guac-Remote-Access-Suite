-- A "demo" is a named, curated slice of existing connections and bookmarks
-- (e.g. "veeamdemo") that can be handed to a specific user for a
-- demonstration WITHOUT granting them any access to the underlying
-- connection_lists those items actually live in. Demo access is deliberately
-- a separate, narrower grant from list_user_permissions/list_group_permissions.
CREATE TABLE demos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- References an existing connection or bookmark by id — a demo never owns
-- its own copy of the item, it just curates a view onto items that still
-- live in (and are still managed via) their original connection_lists.
CREATE TABLE demo_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    demo_id UUID NOT NULL REFERENCES demos(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL CHECK (item_type IN ('connection', 'bookmark')),
    item_id UUID NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (demo_id, item_type, item_id)
);

-- Who can view/use this demo. A grant here gives access to exactly the
-- items in demo_items — nothing broader — regardless of whatever list
-- permissions the granted user does or doesn't otherwise have.
CREATE TABLE demo_access (
    demo_id UUID NOT NULL REFERENCES demos(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (demo_id, user_id)
);

CREATE INDEX idx_demo_items_demo_id ON demo_items(demo_id);
CREATE INDEX idx_demo_items_item ON demo_items(item_type, item_id);
CREATE INDEX idx_demo_access_user_id ON demo_access(user_id);
