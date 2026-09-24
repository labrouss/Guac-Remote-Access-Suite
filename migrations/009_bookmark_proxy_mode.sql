-- 'direct' (default): frontend opens bookmark.url straight in a new tab.
-- 'proxied': the backend reverse-proxies the target through /proxy/:bookmarkId,
-- for internal-only hosts the user's browser can't reach but the backend
-- container's network can (e.g. an isolated management VLAN).
ALTER TABLE bookmarks ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'direct'
    CHECK (access_mode IN ('direct', 'proxied'));
