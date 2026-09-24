import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface OpenSessionSummary {
  key: string;
  connectionId?: string;
  protocol: string;
  name: string;
}

interface SharedSession {
  session_id: string;
  connection_id: string;
  connection_name: string;
  protocol: string;
  owner_username: string;
  role: 'viewer' | 'interactive';
}

interface Props {
  sessions: OpenSessionSummary[];
  activeKey: string | null;
  apiBase: string;
  authToken: string;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onDismiss: () => void;
  onOpenOverview: () => void;
  onJoin: (sessionId: string, connectionId: string, protocol: string, name: string, readOnly: boolean) => void;
}

/**
 * A lightweight dropdown listing every open session by name, distinct from
 * SessionOverview's visual snapshot grid (Ctrl+Alt+Up) — this is the
 * always-available, click-based way to see what's open regardless of how
 * many sessions there are (the tab strip only appears once there are two
 * or more). Closes on outside click or Escape, same pattern as
 * ConnectionPanel's own dismiss behavior.
 *
 * Also surfaces "shared with you" — live sessions someone else has granted
 * this user access to co-view/co-control (see ShareSessionButton.tsx on
 * the granting side). Fetched once on open, not polled — a share showing
 * up here a few seconds late isn't worth a polling loop for a dropdown
 * that's only open briefly.
 */
export function SessionMenu({
  sessions,
  activeKey,
  apiBase,
  authToken,
  onSelect,
  onClose,
  onDismiss,
  onOpenOverview,
  onJoin
}: Props) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [sharedWithMe, setSharedWithMe] = useState<SharedSession[]>([]);

  useEffect(() => {
    fetch(`${apiBase}/api/sessions/shared-with-me`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then(setSharedWithMe);
  }, [apiBase, authToken]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onDismiss();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onDismiss]);

  return (
    <div className="session-menu" ref={menuRef}>
      <div className="session-menu-title">{t('sessionMenu.openSessions')}</div>
      {sessions.length === 0 ? (
        <p className="session-menu-empty">{t('sessionMenu.empty')}</p>
      ) : (
        <ul className="session-menu-list">
          {sessions.map((s) => (
            <li key={s.key}>
              <button
                className={`session-menu-item ${s.key === activeKey ? 'is-active' : ''}`}
                onClick={() => onSelect(s.key)}
              >
                <span className="session-menu-item-name">{s.name}</span>
                <span className="protocol-tag">{s.protocol}</span>
                <span
                  className="session-menu-item-close"
                  onClick={(e) => { e.stopPropagation(); onClose(s.key); }}
                >
                  ×
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {sessions.length > 1 && (
        <button className="session-menu-overview-link" onClick={onOpenOverview}>
          {t('sessionMenu.viewAllThumbnails')}
        </button>
      )}

      {sharedWithMe.length > 0 && (
        <>
          <div className="session-menu-title">{t('sessionMenu.sharedWithYou')}</div>
          <ul className="session-menu-list">
            {sharedWithMe.map((s) => (
              <li key={s.session_id}>
                <button
                  className="session-menu-item"
                  onClick={() =>
                    onJoin(
                      s.session_id,
                      s.connection_id,
                      s.protocol,
                      `${s.connection_name} (${s.owner_username})`,
                      s.role === 'viewer'
                    )
                  }
                >
                  <span className="session-menu-item-name">
                    {s.connection_name} <span className="admin-hint">{t('sessionMenu.by', { username: s.owner_username })}</span>
                  </span>
                  <span className="protocol-tag">{s.role === 'viewer' ? t('share.viewOnly') : t('share.canControl')}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
