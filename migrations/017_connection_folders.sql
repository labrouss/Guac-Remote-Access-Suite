-- Folders for organizing connections within a list — e.g. a "linux"
-- folder holding ariadne, minos, etc. Requested directly, kept
-- deliberately simple: a single, flat grouping level (a NULLABLE text
-- column), not a fully separate hierarchical folder entity with its own
-- id/parent-folder/nesting. Matches the actual request as given (one
-- named group holding some connections), and avoids the considerably
-- larger scope of a real nested-folder table, its own CRUD, and
-- drag-and-drop reordering UI — connections with no folder (NULL)
-- continue to show at the top level exactly as they do today, so this
-- is purely additive.
ALTER TABLE connections ADD COLUMN folder TEXT;
CREATE INDEX idx_connections_list_folder ON connections(list_id, folder);
