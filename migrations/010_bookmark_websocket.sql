-- Off by default: most internal tools proxied here are plain HTTP(S) and
-- don't need it, and enabling WebSocket upgrade proxying for a target that
-- doesn't use it is just unused attack surface for no benefit.
ALTER TABLE bookmarks ADD COLUMN enable_websocket BOOLEAN NOT NULL DEFAULT false;
