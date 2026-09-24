interface BookmarkLike {
  id: string;
  url: string;
  access_mode: 'direct' | 'proxied';
}

/**
 * Prepends https:// when a URL is missing a scheme entirely, rather
 * than only reporting the resulting invalid_url failure after the fact.
 * Most people typing a bookmark URL naturally omit the scheme, the same
 * way a browser's own address bar doesn't require typing it — this
 * matches that same everyday expectation instead of silently failing
 * (or, in BookmarkPanel.tsx's case before this fix, failing with zero
 * feedback at all) on the most common way to type one.
 *
 * Deliberately only checks for a *complete absence* of scheme (no "://"
 * anywhere at all), not a specific http/https prefix — someone who
 * explicitly typed a different scheme (e.g. a URL intended to open a
 * local app via a custom protocol handler) has already made a deliberate
 * choice this shouldn't override, even though the backend's own
 * isValidHttpUrl will still reject anything that isn't ultimately
 * http(s) either way.
 */
export function normalizeBookmarkUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed.includes('://')) return trimmed;
  // Also strips leading slashes before prepending a scheme — a bare
  // "/example.com" (no scheme at all) isn't a valid absolute URL either
  // way, and simply prepending https:// to it as-is would produce
  // "https:///example.com" (an empty host, path "/example.com"), not
  // the "https://example.com" that was almost certainly intended.
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

/**
 * Direct bookmarks just open normally. Proxied ones first need a same-tab
 * fetch to set the path-scoped auth cookie (a window.open() navigation can't
 * carry the Authorization header), then open the proxy path. Shared between
 * BookmarkPanel and DemoPanel so both "open a bookmark" flows stay in sync.
 */
export async function openBookmark(bookmark: BookmarkLike, apiBase: string, authToken: string) {
  if (bookmark.access_mode === 'direct') {
    window.open(bookmark.url, '_blank', 'noopener,noreferrer');
    return;
  }

  const res = await fetch(`${apiBase}/api/bookmarks/${bookmark.id}/proxy-session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
    credentials: 'include'
  });
  if (!res.ok) return;
  const { openUrl } = await res.json();
  window.open(`${apiBase}${openUrl}`, '_blank', 'noopener,noreferrer');
}
