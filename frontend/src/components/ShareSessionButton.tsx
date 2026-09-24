import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPicker } from './UserPicker';

interface Props {
  sessionId: string | null; // null until SessionViewport reports the real backend session id
  apiBase: string;
  authToken: string;
  /** Real bug found live: this popover's own UserPicker search input
   * couldn't be typed into whenever a session was open behind it — same
   * root cause as the earlier /admin and connections-panel keyboard
   * bugs, just a different trigger. AppShell folds this into the same
   * isActive calculation that already accounts for those. */
  onVisibilityChange?: (visible: boolean) => void;
}

/**
 * Only meaningful for the session OWNER — a joiner viewing someone else's
 * shared session has nothing to share themselves, so MainApp only renders
 * this for sessions the current user opened directly, not joined.
 */
export function ShareSessionButton({ sessionId, apiBase, authToken, onVisibilityChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<any[]>([]);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onVisibilityChange?.(open);
    // Not included in the dependency array — see ConnectionPanel.tsx's
    // identical effect for why (onVisibilityChange is a fresh inline
    // closure on every AppShell render, not memoized there).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Unlike ConnectionPanel (always mounted for as long as the app is),
  // this component genuinely unmounts while `open` can still be true —
  // AppShell only renders it for the currently active session at all
  // (see the session-slot map in AppShell.tsx), so switching sessions or
  // navigating to /admin while the popover is open unmounts this
  // instance outright. Without this cleanup, nothing would ever call
  // onVisibilityChange(false) again in that case, leaving the parent's
  // visibility flag — and therefore every future session's keyboard —
  // permanently stuck disabled.
  useEffect(() => {
    return () => onVisibilityChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function authHeaders(json = true) {
    const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  function refreshShares() {
    if (!sessionId) return;
    fetch(`${apiBase}/api/sessions/${sessionId}/shares`, { headers: authHeaders(false) })
      .then((r) => (r.ok ? r.json() : []))
      .then(setShares);
  }

  useEffect(() => {
    if (open) refreshShares();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  async function grant(userId: string, role: 'viewer' | 'interactive') {
    if (!sessionId) return;
    await fetch(`${apiBase}/api/sessions/${sessionId}/share`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId, role })
    });
    refreshShares();
  }

  async function revoke(userId: string) {
    if (!sessionId) return;
    await fetch(`${apiBase}/api/sessions/${sessionId}/share/${userId}`, {
      method: 'DELETE',
      headers: authHeaders(false)
    });
    refreshShares();
  }

  if (!sessionId) return null; // real session id not known yet — see SessionViewport's onSessionReady

  return (
    <div className="share-session-anchor" ref={popoverRef}>
      <button className="record-toggle" onClick={() => setOpen((v) => !v)}>
        {t('share.button')}
      </button>
      {open && (
        <div className="share-popover">
          <div className="share-popover-title">{t('share.popoverTitle')}</div>
          <UserPicker
            apiBase={apiBase}
            authToken={authToken}
            placeholder={t('share.addPersonPlaceholder')}
            onSelect={(u) => grant(u.id, 'viewer')}
          />
          <ul className="share-list">
            {shares.map((s) => (
              <li key={s.granted_to_user_id} className="share-list-item">
                <span>{s.username}</span>
                <select
                  value={s.role}
                  onChange={(e) => grant(s.granted_to_user_id, e.target.value as 'viewer' | 'interactive')}
                >
                  <option value="viewer">{t('share.viewOnly')}</option>
                  <option value="interactive">{t('share.canControl')}</option>
                </select>
                <button onClick={() => revoke(s.granted_to_user_id)}>{t('share.remove')}</button>
              </li>
            ))}
            {shares.length === 0 && <li className="admin-hint">{t('share.notSharedYet')}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
