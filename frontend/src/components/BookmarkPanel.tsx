import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openBookmark as openBookmarkShared, normalizeBookmarkUrl } from '../lib/openBookmark';

interface Bookmark {
  id: string;
  name: string;
  url: string;
  description: string;
  access_mode: 'direct' | 'proxied';
  enable_websocket: boolean;
  folder_id: string | null;
}
interface FolderSummary {
  id: string;
  name: string;
}

interface Props {
  listId: string;
  apiBase: string;
  authToken: string;
}

export function BookmarkPanel({ listId, apiBase, authToken }: Props) {
  const { t } = useTranslation();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  // Same rationale as ConnectionPanel.tsx's identical state: default
  // expanded, not persisted, so a fresh page load always shows
  // everything rather than a folder silently staying collapsed from a
  // previous visit with no visible indication why.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({
    name: '',
    url: '',
    accessMode: 'direct' as 'direct' | 'proxied',
    enableWebsocket: false,
    folderId: ''
  });
  const [adding, setAdding] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // No edit function existed at all before this — only create and
  // delete-via-nothing-either, confirmed by reading this file directly
  // rather than assuming from the reported gap. The backend already
  // fully supported PUT /:id; this was purely a missing frontend gap.
  // Reuses the same form/adding state as the add flow rather than a
  // fully separate edit form, since the two are otherwise identical —
  // editingBookmark being non-null is what distinguishes "Save" meaning
  // create vs. update.
  const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null);

  function authHeaders(json = false) {
    const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  function refresh() {
    fetch(`${apiBase}/api/bookmarks/lists/${listId}`, { headers: authHeaders() })
      .then((res) => res.json())
      .then((data) => setBookmarks(data.bookmarks));
  }
  useEffect(refresh, [listId, apiBase, authToken]);

  function refreshFolders() {
    fetch(`${apiBase}/api/bookmarks/lists/${listId}/folders`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : { folders: [] }))
      .then((data) => setFolders(data.folders));
  }
  useEffect(refreshFolders, [listId, apiBase, authToken]);

  const unfoldered = bookmarks.filter((b) => !b.folder_id);
  const sortedFolders = [...folders].sort((a, b) => a.name.localeCompare(b.name));
  const byFolder = new Map<string, Bookmark[]>(
    sortedFolders.map((f) => [f.id, bookmarks.filter((b) => b.folder_id === f.id)])
  );

  function toggleFolder(id: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveBookmark() {
    if (!form.name || !form.url) return;
    const isEdit = !!editingBookmark;
    // Real bug found live, worse than just an unhelpful message: this
    // never checked res.ok at all before — a failed save (e.g. a URL
    // missing http(s)://, which new URL() on the backend rejects
    // outright) silently closed the form and called refresh() anyway,
    // so the bookmark just never appeared with no indication why at
    // all. Also auto-normalizes the URL before sending rather than only
    // reporting the failure after the fact — most people typing a
    // bookmark URL naturally omit the scheme, the same way a browser's
    // own address bar doesn't require typing it.
    const url = normalizeBookmarkUrl(form.url);
    const res = await fetch(
      isEdit ? `${apiBase}/api/bookmarks/${editingBookmark!.id}` : `${apiBase}/api/bookmarks/lists/${listId}`,
      {
        method: isEdit ? 'PUT' : 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ ...form, url })
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setSaveError(
        body.error === 'invalid_url'
          ? t('adminBookmarks.invalidUrl')
          : t('adminBookmarks.saveError')
      );
      return;
    }
    setSaveError(null);
    setForm({ name: '', url: '', accessMode: 'direct', enableWebsocket: false, folderId: '' });
    setAdding(false);
    setEditingBookmark(null);
    refresh();
  }

  function startEditing(bookmark: Bookmark) {
    setEditingBookmark(bookmark);
    setForm({
      name: bookmark.name,
      url: bookmark.url,
      accessMode: bookmark.access_mode,
      enableWebsocket: bookmark.enable_websocket,
      folderId: bookmark.folder_id ?? ''
    });
    setAdding(true);
    setSaveError(null);
  }

  function cancelForm() {
    setAdding(false);
    setEditingBookmark(null);
    setForm({ name: '', url: '', accessMode: 'direct', enableWebsocket: false, folderId: '' });
    setSaveError(null);
  }

  async function deleteBookmark(id: string) {
    if (!confirm(t('bookmarkPanel.deleteConfirm'))) return;
    await fetch(`${apiBase}/api/bookmarks/${id}`, { method: 'DELETE', headers: authHeaders() });
    refresh();
  }

  // Direct bookmarks just open normally; proxied ones go through the shared
  // proxy-session flow. See lib/openBookmark.ts.
  function openBookmark(bookmark: Bookmark) {
    return openBookmarkShared(bookmark, apiBase, authToken);
  }

  // Downloads a Netscape-format .html file — Chrome: chrome://bookmarks →
  // ⋮ menu → "Import bookmarks" accepts this directly, as do Firefox and Edge.
  // Proxied bookmarks are excluded server-side since their URLs are only
  // reachable through this app, not a real browser's own network path.
  //
  // Real bug found live: this used window.open(url) directly, which is a
  // plain browser navigation — it cannot carry a custom Authorization
  // header. This app's auth token lives in sessionStorage, not a cookie,
  // so there was no way for that navigation to authenticate at all; every
  // export request hit the backend's requireAuth middleware with no
  // Bearer header and failed with missing_token, regardless of whether
  // the person was logged in. The feature could never have worked as
  // written. Fixed by fetching the file with the same authHeaders() this
  // component already uses for every other request, then building a
  // temporary download link from the response blob — the standard
  // pattern for downloading an authenticated file from a bearer-token SPA.
  // The filename is read back from the server's own Content-Disposition
  // header rather than reconstructed here, so it stays byte-for-byte in
  // sync with the backend's sanitizeFilename() logic instead of two
  // independent implementations that could quietly drift apart.
  async function exportForBrowser() {
    const res = await fetch(`${apiBase}/api/bookmarks/lists/${listId}/export-html`, {
      headers: authHeaders()
    });
    if (!res.ok) return;
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    const filename = filenameMatch ? filenameMatch[1] : 'bookmarks.html';
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importFromBrowserFile(file: File) {
    const html = await file.text();
    await fetch(`${apiBase}/api/bookmarks/lists/${listId}/import-html`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ html })
    });
    refresh();
  }

  return (
    <div className="bookmark-panel">
      <div className="bookmark-panel-header">
        <span>{t('connectionPanel.title')}</span>
        <div className="bookmark-panel-actions">
          <button onClick={() => (adding ? cancelForm() : setAdding(true))}>{adding ? t('common.cancel') : t('bookmarkPanel.addButton')}</button>
          <button onClick={exportForBrowser} title={t('bookmarkPanel.exportTitle')}>
            {t('bookmarkPanel.exportForBrowser')}
          </button>
          <label className="bookmark-import-label">
            {t('bookmarkPanel.import')}
            <input
              type="file"
              accept=".html"
              hidden
              onChange={(e) => e.target.files?.[0] && importFromBrowserFile(e.target.files[0])}
            />
          </label>
        </div>
      </div>

      {adding && (
        <div className="bookmark-add-form">
          <input
            placeholder={t('connectionForm.namePlaceholder')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            placeholder={t('bookmarkPanel.urlPlaceholder')}
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
          />
          <select
            value={form.accessMode}
            onChange={(e) => setForm({ ...form, accessMode: e.target.value as 'direct' | 'proxied' })}
          >
            <option value="direct">{t('bookmarkPanel.accessModeDirect')}</option>
            <option value="proxied">{t('bookmarkPanel.accessModeProxied')}</option>
          </select>
          {form.accessMode === 'proxied' && (
            <label className="bookmark-checkbox">
              <input
                type="checkbox"
                checked={form.enableWebsocket}
                onChange={(e) => setForm({ ...form, enableWebsocket: e.target.checked })}
              />
              {t('bookmarkPanel.websocketCheckbox')}
            </label>
          )}
          <select value={form.folderId} onChange={(e) => setForm({ ...form, folderId: e.target.value })}>
            <option value="">{t('connectionForm.noFolder')}</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <button onClick={saveBookmark}>{editingBookmark ? t('adminBookmarks.saveChanges') : t('common.save')}</button>
          {editingBookmark && (
            <button onClick={cancelForm} className="add-connection-cancel">
              {t('common.cancel')}
            </button>
          )}
          {saveError && <p className="setup-error">{saveError}</p>}
        </div>
      )}

      <ul className="bookmark-list">
        {unfoldered.map((b) => (
          <li key={b.id} className="bookmark-list-item">
            <button className="bookmark-item" onClick={() => openBookmark(b)} title={b.description}>
              {b.name}
              {b.access_mode === 'proxied' && <span className="proxied-tag">{t('bookmarkPanel.proxiedTag')}</span>}
            </button>
            <span className="bookmark-item-actions">
              <button onClick={() => startEditing(b)}>{t('admin.listDetail.edit')}</button>
              <button onClick={() => deleteBookmark(b.id)}>{t('admin.listDetail.delete')}</button>
            </span>
          </li>
        ))}
        {sortedFolders.map((folder) => (
          <li key={folder.id} className="connection-folder">
            <button className="connection-folder-header" onClick={() => toggleFolder(folder.id)}>
              <span className="folder-toggle-icon">{collapsedFolders.has(folder.id) ? '▸' : '▾'}</span>
              {folder.name}
            </button>
            {!collapsedFolders.has(folder.id) && (
              <ul className="bookmark-list connection-folder-contents">
                {(byFolder.get(folder.id) ?? []).map((b) => (
                  <li key={b.id} className="bookmark-list-item">
                    <button className="bookmark-item" onClick={() => openBookmark(b)} title={b.description}>
                      {b.name}
                      {b.access_mode === 'proxied' && <span className="proxied-tag">{t('bookmarkPanel.proxiedTag')}</span>}
                    </button>
                    <span className="bookmark-item-actions">
                      <button onClick={() => startEditing(b)}>{t('admin.listDetail.edit')}</button>
                      <button onClick={() => deleteBookmark(b.id)}>{t('admin.listDetail.delete')}</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
