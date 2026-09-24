-- A "personal" list is auto-provisioned per user for their own private
-- connections — visible only to them, never shared, distinct from the
-- ordinary connection_lists that admins create and grant to groups/users.
ALTER TABLE connection_lists ADD COLUMN is_personal BOOLEAN NOT NULL DEFAULT false;

-- At most one personal list per user.
CREATE UNIQUE INDEX idx_one_personal_list_per_owner
    ON connection_lists (owner_id)
    WHERE is_personal = true;
