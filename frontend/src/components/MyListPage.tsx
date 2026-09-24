import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ListDetail } from './AdminPanel';

/**
 * Requested directly: edit/delete/export/import for a user's own private
 * connections, without needing global admin status at all. The backend
 * already fully supported this — every connection/folder/export/import
 * route in admin.ts is gated by requireListPermission (list-scoped), not
 * requireAdmin (a global flag), and every user always has 'admin'
 * permission on their own personal list from the moment it's
 * auto-provisioned. The only actual gap was a frontend way to reach that
 * functionality without being a global admin: the admin panel's own
 * "Lists" tab requires requireAdmin just to load its user/group tabs,
 * and — since a recent fix — no longer even lists personal lists at all
 * (they were never meant to be browsed there; see admin.ts's own comment
 * on GET /admin/lists for why).
 *
 * Reuses ListDetail directly rather than rebuilding equivalent UI —
 * same connections table, folders, bookmarks, recordings, export/import
 * this file's sibling AdminPanel.tsx already has, just reached without
 * an admin-only route wrapping it. ListDetail's own "Grant access"
 * sections are already hidden for a personal list (is_personal guard
 * added alongside this feature, since granting access to a list that
 * can never be shared never made sense there either), so this page
 * doesn't need to suppress anything itself.
 */
export function MyListPage() {
  const { t } = useTranslation();
  const apiBase = ''; // same-origin; nginx proxies /api to the backend — matches AppShell.tsx's own API_BASE
  const authToken = sessionStorage.getItem('guac.sessionToken') ?? '';
  const [list, setList] = useState<{ id: string; name: string; description: string; is_personal: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    fetch(`${apiBase}/api/connections/lists`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((lists: any[]) => {
        const personal = lists.find((l) => l.is_personal);
        if (!personal) {
          setError(t('myListPage.notFound'));
        } else {
          setList(personal);
        }
        setLoading(false);
      })
      .catch(() => {
        setError(t('myListPage.loadError'));
        setLoading(false);
      });
  }
  useEffect(refresh, []);

  return (
    <div className="admin-panel">
      <Link to="/" className="admin-back-link">{t('admin.backToConnections')}</Link>
      <h2>{t('myListPage.title')}</h2>
      {loading && <p>{t('common.loading')}</p>}
      {error && <p className="setup-error">{error}</p>}
      {list && (
        <ListDetail
          apiBase={apiBase}
          authToken={authToken}
          listId={list.id}
          list={list}
          onListChanged={refresh}
          onListDeleted={refresh}
        />
      )}
    </div>
  );
}
