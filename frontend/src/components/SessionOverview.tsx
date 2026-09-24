import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface OpenSessionSummary {
  key: string;
  connectionId?: string;
  protocol: string;
  name: string;
}

interface Props {
  sessions: OpenSessionSummary[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onDismiss: () => void;
}

/**
 * Triggered by Ctrl+Alt+Up (left-side modifiers specifically — see
 * MainApp.tsx). Snapshots each open session's live canvas via
 * `canvas.toDataURL()` at the moment the overview opens — a one-time
 * snapshot, not a live-updating thumbnail, same idea as an OS-level
 * Alt-Tab switcher preview. Every open session stays connected underneath
 * regardless of whether its snapshot is currently showing here.
 */
export function SessionOverview({ sessions, activeKey, onSelect, onClose, onDismiss }: Props) {
  const { t } = useTranslation();
  const [snapshots, setSnapshots] = useState<Record<string, string>>({});

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const s of sessions) {
      const canvas = document.querySelector<HTMLCanvasElement>(
        `[data-session-key="${s.key}"] canvas`
      );
      if (canvas) {
        try {
          next[s.key] = canvas.toDataURL('image/png');
        } catch {
          // toDataURL can throw if the canvas is tainted or zero-sized —
          // just fall back to showing no snapshot for that card.
        }
      }
    }
    setSnapshots(next);
  }, [sessions]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  return (
    <div className="session-overview-backdrop" onClick={onDismiss}>
      <div className="session-overview-grid" onClick={(e) => e.stopPropagation()}>
        {sessions.length === 0 && (
          <p className="admin-hint">{t('sessionOverview.noOpenSessions')}</p>
        )}
        {sessions.map((s) => (
          <button
            key={s.key}
            className={`session-overview-card ${s.key === activeKey ? 'is-active' : ''}`}
            onClick={() => onSelect(s.key)}
          >
            <span className="session-overview-close" onClick={(e) => { e.stopPropagation(); onClose(s.key); }}>
              ×
            </span>
            {snapshots[s.key] ? (
              <img src={snapshots[s.key]} alt={s.name} />
            ) : (
              <div className="session-overview-placeholder" />
            )}
            <span className="session-overview-label">
              {s.name} <span className="protocol-tag">{s.protocol}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="session-overview-hint">
        {t('sessionOverview.keyboardHint')}
      </p>
    </div>
  );
}
