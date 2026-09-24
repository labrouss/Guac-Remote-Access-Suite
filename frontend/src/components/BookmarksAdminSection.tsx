import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authHeaders } from './AdminPanel';
import { normalizeBookmarkUrl } from '../lib/openBookmark';

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
  apiBase: string;
  authToken: string;
  listId: string;
}

const emptyForm = {
  name: '', url: '', description: '', accessMode: 'direct' as 'direct' | 'proxied', enableWebsocket: false, folderId: ''
};

/**
 * Requested directly: a way to manage bookmarks from the admin view the
 * same way connections are managed there — a table with inline
 * edit/delete, not the compact side-panel list BookmarkPanel.tsx uses
 * for the regular connections view. Deliberately a separate component
 * rather than folding this into BookmarkPanel.tsx itself: the two serve
 * different contexts (a narrow hover panel vs. a full admin table) and
 * trying to make one component serve both would mean threading a
 * display-mode flag through every piece of its render. Reuses the same
 * backend routes BookmarkPanel.tsx already uses — no backend changes
 * needed for this, since bookmarks/routes.ts already had complete
 * PUT/DELETE support (fixed for BookmarkPanel.tsx a couple of rounds
 * back), only the admin-facing UI is new here.
 */
export function BookmarksAdminSection({ apiBase, authToken, listId }: Props) {
  const { t } = useTranslation();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Real, standalone folder entities (migration 019) — mirrors
  // connection_folders and AdminPanel.tsx's ListDetail exactly. See that
  // migration's own comment for why bookmarks get their own separate
  // folders table rather than sharing connections' one.
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);

  function refresh() {
    fetch(`${apiBase}/api/bookmarks/lists/${listId}`, { headers: authHeaders(authToken, false) })
      .then((r) => (r.ok ? r.json() : { bookmarks: [] }))
      .then((d) => setBookmarks(d.bookmarks));
  }
  useEffect(refresh, [apiBase, authToken, listId]);

  function refreshFolders() {
    fetch(`${apiBase}/api/bookmarks/lists/${listId}/folders`, { headers: authHeaders(authToken, false) })
      .then((r) => (r.ok ? r.json() : { folders: [] }))
      .then((d) => setFolders(d.folders));
  }
  useEffect(refreshFolders, [apiBase, authToken, listId]);

  async function createFolder() {
    setFolderError(null);
    if (!newFolderName.trim()) return;
    const res = await fetch(`${apiBase}/api/bookmarks/lists/${listId}/folders`, {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ name: newFolderName.trim() })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFolderError(body.error === 'folder_already_exists' ? t('admin.listDetail.folderAlreadyExists') : t('admin.listDetail.createFolderError'));
      return;
    }
    setNewFolderName('');
    refreshFolders();
  }

  async function renameFolder(folder: FolderSummary) {
    const newName = prompt(t('admin.listDetail.renameFolderPrompt', { folderName: folder.name }), folder.name);
    if (newName === null || !newName.trim() || newName.trim() === folder.name) return;
    const res = await fetch(`${apiBase}/api/bookmarks/folders/${folder.id}`, {
      method: 'PUT',
      headers: authHeaders(authToken),
      body: JSON.stringify({ name: newName.trim() })
    });
    if (!res.ok) {
      setFolderError(t('admin.listDetail.renameFolderError'));
      return;
    }
    refreshFolders();
  }

  async function deleteFolder(folder: FolderSummary) {
    if (!confirm(t('adminBookmarks.deleteFolderConfirm', { folderName: folder.name }))) return;
    const res = await fetch(`${apiBase}/api/bookmarks/folders/${folder.id}`, {
      method: 'DELETE',
      headers: authHeaders(authToken)
    });
    if (!res.ok) {
      setFolderError(t('admin.listDetail.deleteFolderError'));
      return;
    }
    refreshFolders();
    refresh();
  }

  // Dedicated PATCH endpoint, not the full bookmark PUT — see that
  // endpoint's own comment in bookmarks.ts (identical reasoning to the
  // connections version): this table doesn't reliably have every current
  // field for every row already in hand, so a full PUT risks clobbering
  // something else whenever this is the only thing actually changing.
  async function assignBookmarkFolder(bookmarkId: string, folderId: string) {
    await fetch(`${apiBase}/api/bookmarks/${bookmarkId}/folder`, {
      method: 'PATCH',
      headers: authHeaders(authToken),
      body: JSON.stringify({ folderId: folderId || null })
    });
    refresh();
  }

  function startAdding() {
    setEditingBookmark(null);
    setForm(emptyForm);
    setAdding(true);
    setError(null);
  }

  function startEditing(bookmark: Bookmark) {
    setEditingBookmark(bookmark);
    setForm({
      name: bookmark.name,
      url: bookmark.url,
      description: bookmark.description ?? '',
      accessMode: bookmark.access_mode,
      enableWebsocket: bookmark.enable_websocket,
      folderId: bookmark.folder_id ?? ''
    });
    setAdding(true);
    setError(null);
  }

  function cancelForm() {
    setAdding(false);
    setEditingBookmark(null);
    setForm(emptyForm);
    setError(null);
  }

  async function saveBookmark() {
    if (!form.name || !form.url) return;
    const isEdit = !!editingBookmark;
    // Real bug found live: the reported "Could not save this bookmark"
    // was too generic to explain why — the actual cause is the backend
    // rejecting any URL missing a scheme (new URL('/vcsa.example.com')
    // throws), which is exactly the kind of thing someone typing a
    // bookmark URL naturally does without thinking about (a browser's
    // own address bar doesn't require it either). Normalizes the URL
    // client-side first, same fix as BookmarkPanel.tsx's identical
    // issue, and falls back to a specific message read from the actual
    // response body if it's still rejected for some other reason.
    const url = normalizeBookmarkUrl(form.url);
    const res = await fetch(
      isEdit ? `${apiBase}/api/bookmarks/${editingBookmark!.id}` : `${apiBase}/api/bookmarks/lists/${listId}`,
      {
        method: isEdit ? 'PUT' : 'POST',
        headers: authHeaders(authToken),
        body: JSON.stringify({ ...form, url })
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error === 'invalid_url' ? t('adminBookmarks.invalidUrl') : t('adminBookmarks.saveError'));
      return;
    }
    cancelForm();
    refresh();
  }

  async function deleteBookmark(id: string) {
    if (!confirm(t('adminBookmarks.deleteBookmarkConfirm'))) return;
    const res = await fetch(`${apiBase}/api/bookmarks/${id}`, { method: 'DELETE', headers: authHeaders(authToken) });
    if (!res.ok) {
      setError(t('adminBookmarks.deleteBookmarkError'));
      return;
    }
    refresh();
  }

  return (
    <div className="admin-bookmarks-section">
      <h3>{t('adminBookmarks.title')}</h3>

      {!adding && <button onClick={startAdding}>{t('adminBookmarks.addBookmark')}</button>}

      {adding && (
        <div className="admin-form-row admin-form-row-wrap">
          <input placeholder={t('admin.listDetail.namePlaceholder')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder={t('adminBookmarks.urlPlaceholder')} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <input
            placeholder={t('adminBookmarks.descriptionOptionalPlaceholder')}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <select
            value={form.accessMode}
            onChange={(e) => setForm({ ...form, accessMode: e.target.value as 'direct' | 'proxied' })}
          >
            <option value="direct">{t('adminBookmarks.accessModeDirect')}</option>
            <option value="proxied">{t('adminBookmarks.accessModeProxied')}</option>
          </select>
          {form.accessMode === 'proxied' && (
            <label className="admin-checkbox">
              <input
                type="checkbox"
                checked={form.enableWebsocket}
                onChange={(e) => setForm({ ...form, enableWebsocket: e.target.checked })}
              />
              {t('adminBookmarks.enableWebsocket')}
            </label>
          )}
          <select value={form.folderId} onChange={(e) => setForm({ ...form, folderId: e.target.value })}>
            <option value="">{t('admin.listDetail.noFolder')}</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <button onClick={saveBookmark}>{editingBookmark ? t('adminBookmarks.saveChanges') : t('common.save')}</button>
          <button onClick={cancelForm} className="add-connection-cancel">{t('common.cancel')}</button>
        </div>
      )}
      {error && <p className="setup-error">{error}</p>}

      <div className="admin-folders-manage">
        <h4>{t('admin.listDetail.foldersHeading')}</h4>
        <div className="admin-form-row">
          <input
            placeholder={t('admin.listDetail.newFolderNamePlaceholder')}
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
          />
          <button onClick={createFolder}>{t('admin.listDetail.createFolder')}</button>
        </div>
        {folderError && <p className="setup-error">{folderError}</p>}
        {folders.length > 0 && (
          <ul className="admin-folders-list">
            {folders.map((f) => (
              <li key={f.id}>
                <span>{f.name}</span>
                <button onClick={() => renameFolder(f)}>{t('admin.listDetail.rename')}</button>
                <button onClick={() => deleteFolder(f)}>{t('admin.listDetail.delete')}</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <table className="admin-table">
        <thead><tr><th>{t('admin.listDetail.colName')}</th><th>{t('adminBookmarks.colUrl')}</th><th>{t('adminBookmarks.colAccess')}</th><th>{t('admin.listDetail.colFolder')}</th><th></th></tr></thead>
        <tbody>
          {bookmarks.map((b) => (
            <tr key={b.id}>
              <td>{b.name}</td>
              <td>{b.url}</td>
              <td>{b.access_mode}{b.access_mode === 'proxied' && b.enable_websocket ? ' + ws' : ''}</td>
              <td>
                <select
                  value={b.folder_id ?? ''}
                  onChange={(e) => assignBookmarkFolder(b.id, e.target.value)}
                >
                  <option value="">{t('admin.listDetail.noneFolder')}</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </td>
              <td>
                <button onClick={() => startEditing(b)}>{t('admin.listDetail.edit')}</button>{' '}
                <button onClick={() => deleteBookmark(b.id)}>{t('admin.listDetail.delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
