import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookmarkPanel } from './BookmarkPanel';
import { AddConnectionForm } from './AddConnectionForm';

interface ListSummary {
  id: string;
  name: string;
  description: string;
  is_personal: boolean;
  permission: string | null;
}
interface ConnectionSummary {
  id: string;
  name: string;
  protocol: string;
  folder_id: string | null;
}
interface FolderSummary {
  id: string;
  name: string;
}
interface Props {
  apiBase: string;
  authToken: string;
  onOpenConnection: (connectionId: string, protocol: string, name: string) => void;
  /** Real bug found live: this panel's own "Add connection"/bookmark
   * forms couldn't be typed into whenever a session was open behind it
   * — the exact same root cause as the earlier /admin keyboard bug,
   * just a different trigger. The active session's Guacamole.Keyboard
   * has no idea this panel exists or is currently covering part of the
   * screen, so it kept intercepting every keystroke on the page
   * regardless. AppShell uses this to fold "is this panel currently
   * open" into the same isActive calculation that already accounts for
   * being on /admin, so the fix generalizes rather than needing a
   * separate one-off for every overlay that might ever sit on top of a
   * session.
   */
  onVisibilityChange?: (visible: boolean) => void;
}

export function ConnectionPanel({ apiBase, authToken, onOpenConnection, onVisibilityChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [lists, setLists] = useState<ListSummary[]>([]);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  // Which folders are currently collapsed — default expanded (empty
  // set), not persisted across sessions; a fresh page load always shows
  // everything, which is simpler and avoids a folder silently staying
  // collapsed from a previous visit with no visible indication why.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());

  const visible = open || pinned;
  useEffect(() => {
    onVisibilityChange?.(visible);
    // Not included in the dependency array: onVisibilityChange itself
    // is a fresh inline closure on every AppShell render (it isn't
    // memoized there), which would otherwise fire this far more often
    // than the actual visibility genuinely changes. Only visible
    // changing is what should trigger a notification.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    // Real crash found live: this never checked res.ok before — a 401
    // (expired/invalid session, the actual reported scenario) parses
    // to an error object, not an array, and setLists(that object) meant
    // the very next render's lists.find() below threw and crashed the
    // whole app with no error boundary to catch it. The new global
    // fetch interceptor (installAuthFetchInterceptor, wired up in
    // main.tsx) now redirects to /login for exactly this case before
    // this even runs, but checking res.ok here too is the actual fix at
    // the source, not just relying on that as a safety net.
    fetch(`${apiBase}/api/connections/lists`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then(setLists);
  }, [apiBase, authToken]);

  useEffect(() => {
    refreshConnections();
  }, [activeListId, apiBase, authToken]);

  useEffect(() => {
    // Requested directly ("I need to perform a browser refresh"): this
    // panel stays mounted (just hidden/shown via CSS, not
    // unmounted/remounted — see the hover/pin mechanism below) and,
    // beyond the initial mount-time fetch just above, only ever
    // refetched when activeListId itself actually changed. Deleting a
    // connection elsewhere in the app (the admin panel's own list,
    // which does correctly refresh its own separate copy of this same
    // data) left this panel showing stale data indefinitely, since
    // nothing here would ever know that happened. A separate effect
    // specifically for this, rather than folding it into the one above,
    // so the panel still has data ready the instant it's first hovered
    // (no visible loading flash on that very first open) while every
    // *subsequent* open also gets a fresh fetch — never more than a
    // hover away from being wrong for longer than one more request
    // takes.
    if (open) refreshConnections();
  }, [open]);

  function refreshConnections() {
    if (!activeListId) return;
    fetch(`${apiBase}/api/connections/lists/${activeListId}/connections`, {
      headers: { Authorization: `Bearer ${authToken}` }
    })
      .then((r) => (r.ok ? r.json() : { connections: [] }))
      .then((data) => setConnections(data.connections));
    // Real, standalone folder entities (migration 018) — 'view'
    // permission only, matching connections' own visibility, so anyone
    // who can see this list's connections can see its folder names too.
    fetch(`${apiBase}/api/admin/lists/${activeListId}/folders`, {
      headers: { Authorization: `Bearer ${authToken}` }
    })
      .then((r) => (r.ok ? r.json() : { folders: [] }))
      .then((data) => setFolders(data.folders));
  }

  const activeList = lists.find((l) => l.id === activeListId);
  // Matches the backend's own requirement exactly (POST
  // /api/admin/lists/:listId/connections needs 'edit' minimum, not
  // admin-only) — every user already has 'admin' on their own personal
  // list, so this naturally shows there, and also for any shared list an
  // admin has separately granted edit+ access to.
  const canAddConnection = activeList?.permission === 'edit' || activeList?.permission === 'admin';

  // Groups connections by folder — real, standalone entities as of
  // migration 018 (a folder can exist with zero connections in it, and
  // be assigned via a dropdown in the admin view, not only by editing a
  // connection). unfoldered stays a flat list at the top, matching how
  // every connection displayed before folders existed at all; folders
  // themselves are sorted by name for a stable, predictable order.
  const unfoldered = connections.filter((c) => !c.folder_id);
  const sortedFolders = [...folders].sort((a, b) => a.name.localeCompare(b.name));
  const byFolder = new Map<string, ConnectionSummary[]>(
    sortedFolders.map((f) => [f.id, connections.filter((c) => c.folder_id === f.id)])
  );

  function toggleFolder(id: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      {/* Slim always-visible trigger strip */}
      <div
        className="panel-trigger"
        onMouseEnter={() => setOpen(true)}
        onClick={() => setOpen(true)}
      >
        ≡
      </div>

      {visible && (
        <>
          <div className="panel-backdrop" onClick={() => !pinned && setOpen(false)} />
          <div
            className="connection-panel"
            onMouseLeave={() => !pinned && setOpen(false)}
          >
            <div className="connection-panel-header">
              <span>{t('connectionPanel.title')}</span>
              <button className="pin-toggle" onClick={() => setPinned((p) => !p)} title="Keep panel open">
                {pinned ? '📌' : '📍'}
              </button>
            </div>

            <ul className="list-tree">
              {lists.map((list) => (
                <li key={list.id}>
                  <button
                    className={`list-item ${activeListId === list.id ? 'is-active' : ''}`}
                    onClick={() => setActiveListId(list.id)}
                    title={list.description}
                  >
                    {list.name}
                    {list.is_personal && <span className="protocol-tag">{t('connectionPanel.private')}</span>}
                  </button>
                  {activeListId === list.id && (
                    <ul className="connection-tree">
                      {unfoldered.map((c) => (
                        <li key={c.id}>
                          <button
                            className="connection-item"
                            onClick={() => onOpenConnection(c.id, c.protocol, c.name)}
                          >
                            {c.name}
                            <span className="protocol-tag">{c.protocol}</span>
                          </button>
                        </li>
                      ))}
                      {sortedFolders.map((folder) => (
                        <li key={folder.id} className="connection-folder">
                          <button className="connection-folder-header" onClick={() => toggleFolder(folder.id)}>
                            <span className="folder-toggle-icon">{collapsedFolders.has(folder.id) ? '▸' : '▾'}</span>
                            {folder.name}
                          </button>
                          {!collapsedFolders.has(folder.id) && (
                            <ul className="connection-tree connection-folder-contents">
                              {(byFolder.get(folder.id) ?? []).map((c) => (
                                <li key={c.id}>
                                  <button
                                    className="connection-item"
                                    onClick={() => onOpenConnection(c.id, c.protocol, c.name)}
                                  >
                                    {c.name}
                                    <span className="protocol-tag">{c.protocol}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                      {canAddConnection && (
                        <li className="add-connection-slot">
                          <AddConnectionForm
                            listId={list.id}
                            apiBase={apiBase}
                            authToken={authToken}
                            onCreated={refreshConnections}
                            folders={folders}
                          />
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              ))}
            </ul>

            {activeListId && (
              <div className="panel-bookmarks">
                <BookmarkPanel listId={activeListId} apiBase={apiBase} authToken={authToken} />
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
