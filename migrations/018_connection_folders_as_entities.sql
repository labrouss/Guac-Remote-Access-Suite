-- Upgrades folders from a flat text column (017) to a real, standalone
-- entity table. Requested directly: being able to create an empty
-- folder before any connection is assigned to it, and assign a
-- connection to a folder via a dropdown in the connection list view,
-- genuinely cannot be done with just a text column on connections —
-- there's no row for an empty folder to exist as. This is exactly the
-- larger scope 017's own comment described and deliberately deferred at
-- the time, now actually needed.
CREATE TABLE connection_folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id UUID NOT NULL REFERENCES connection_lists(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (list_id, name)
);

ALTER TABLE connections ADD COLUMN folder_id UUID REFERENCES connection_folders(id) ON DELETE SET NULL;

-- Migrates existing data rather than silently dropping it: one real
-- folder row per distinct (list_id, folder-name) pair that's actually in
-- use today, then repoints every connection that had that text value to
-- the new row instead.
INSERT INTO connection_folders (list_id, name)
SELECT DISTINCT list_id, folder FROM connections WHERE folder IS NOT NULL;

UPDATE connections c
SET folder_id = f.id
FROM connection_folders f
WHERE c.folder IS NOT NULL AND c.list_id = f.list_id AND c.folder = f.name;

ALTER TABLE connections DROP COLUMN folder;

CREATE INDEX idx_connection_folders_list_id ON connection_folders(list_id);
CREATE INDEX idx_connections_folder_id ON connections(folder_id);
