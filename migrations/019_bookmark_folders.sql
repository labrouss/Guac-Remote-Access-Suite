-- Folders for bookmarks — same idea as connection_folders (migration
-- 018), requested directly as a separate follow-up. Deliberately a
-- separate table rather than reusing connection_folders for both:
-- bookmarks and connections are different kinds of things being
-- organized, and sharing one folder namespace between them would mean a
-- "linux" folder created for connections showing up as an option for
-- bookmarks too, which isn't what was asked for and would likely be
-- confusing rather than convenient. Built directly as a real entity
-- table from the start, not a flat text column first — 018's own
-- migration history is the reason why: a text column can't represent an
-- empty folder, and that gap had to be fixed with an extra migration
-- once dropdown-based assignment was actually requested. No reason to
-- repeat that same two-step path for bookmarks now that it's already
-- understood upfront.
CREATE TABLE bookmark_folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id UUID NOT NULL REFERENCES connection_lists(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (list_id, name)
);

ALTER TABLE bookmarks ADD COLUMN folder_id UUID REFERENCES bookmark_folders(id) ON DELETE SET NULL;

CREATE INDEX idx_bookmark_folders_list_id ON bookmark_folders(list_id);
CREATE INDEX idx_bookmarks_folder_id ON bookmarks(folder_id);
