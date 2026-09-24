-- NULL = never expires (existing behavior). Set when granting access for a
-- one-off demo/customer call so it doesn't need manual revocation later.
ALTER TABLE demo_access ADD COLUMN expires_at TIMESTAMPTZ;
