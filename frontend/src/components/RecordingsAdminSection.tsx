import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authHeaders } from './AdminPanel';
import { RecordingPlayer } from './RecordingPlayer';

interface Recording {
  id: string;
  session_id: string;
  connection_id: string | null;
  connection_name: string;
  user_id: string;
  username: string;
  started_at: string;
  ended_at: string | null;
  file_size_bytes: number | null;
  export_status: 'none' | 'processing' | 'completed' | 'failed';
}

interface Props {
  apiBase: string;
  authToken: string;
  listId: string;
}

function formatDuration(startedAt: string, endedAt: string | null, inProgressLabel: string): string {
  if (!endedAt) return inProgressLabel;
  const seconds = Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Listing, playback, and delete. The backend's stream/export/status/delete
 * routes are now correctly authorized (policy given directly: an admin,
 * or the recording's own creator, and no one else — see
 * canAccessRecording's own comment in permissions.ts), so it's now safe
 * to link straight to playback here rather than the deliberate gap left
 * in the previous round while that authorization question was still
 * open.
 *
 * Also worth knowing: a recording whose underlying connection has since
 * been deleted won't appear here at all — see this file's backend route
 * (GET /lists/:listId/recordings) for why (there's no remaining way to
 * know which list an orphaned recording belonged to once its
 * connection_id is NULL).
 */
export function RecordingsAdminSection({ apiBase, authToken, listId }: Props) {
  const { t, i18n } = useTranslation();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [playingRecordingId, setPlayingRecordingId] = useState<string | null>(null);

  function refresh() {
    fetch(`${apiBase}/api/admin/lists/${listId}/recordings`, { headers: authHeaders(authToken, false) })
      .then((r) => {
        if (!r.ok) {
          setError(r.status === 403 ? t('adminRecordings.accessDenied') : t('adminRecordings.loadError'));
          return { recordings: [] };
        }
        setError(null);
        return r.json();
      })
      .then((d) => setRecordings(d.recordings));
  }
  useEffect(refresh, [apiBase, authToken, listId]);

  async function deleteRecording(id: string) {
    if (!confirm(t('adminRecordings.deleteConfirm'))) return;
    const res = await fetch(`${apiBase}/api/sessions/recordings/${id}`, {
      method: 'DELETE',
      headers: authHeaders(authToken)
    });
    if (!res.ok) {
      setError(t('adminRecordings.deleteError'));
      return;
    }
    refresh();
  }

  return (
    <div className="admin-bookmarks-section">
      <h3>{t('adminRecordings.title')}</h3>
      {error && <p className="setup-error">{error}</p>}
      {!error && recordings.length === 0 && <p className="admin-empty-state">{t('adminRecordings.noneYet')}</p>}
      {recordings.length > 0 && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t('adminRecordings.colConnection')}</th>
              <th>{t('adminRecordings.colRecordedBy')}</th>
              <th>{t('adminRecordings.colStarted')}</th>
              <th>{t('adminRecordings.colDuration')}</th>
              <th>{t('adminRecordings.colSize')}</th>
              <th>{t('adminRecordings.colExport')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {recordings.map((r) => (
              <tr key={r.id}>
                <td>{r.connection_name}</td>
                <td>{r.username}</td>
                <td>{new Date(r.started_at).toLocaleString(i18n.language)}</td>
                <td>{formatDuration(r.started_at, r.ended_at, t('adminRecordings.inProgress'))}</td>
                <td>{formatBytes(r.file_size_bytes)}</td>
                <td>{r.export_status}</td>
                <td>
                  <button onClick={() => setPlayingRecordingId(r.id)}>{t('adminRecordings.play')}</button>{' '}
                  <button onClick={() => deleteRecording(r.id)}>{t('admin.listDetail.delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {playingRecordingId && (
        <RecordingPlayer
          apiBase={apiBase}
          authToken={authToken}
          recordingId={playingRecordingId}
          onClose={() => setPlayingRecordingId(null)}
        />
      )}
    </div>
  );
}
