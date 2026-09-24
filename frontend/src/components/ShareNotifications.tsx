import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface SharedSession {
  session_id: string;
  connection_id: string;
  connection_name: string;
  protocol: string;
  owner_username: string;
  role: 'viewer' | 'interactive';
}

interface Props {
  apiBase: string;
  authToken: string;
  onJoin: (sessionId: string, connectionId: string, protocol: string, name: string, readOnly: boolean) => void;
}

const POLL_INTERVAL_MS = 10000;

/**
 * Requested directly: sharing a session should reach the recipient as
 * something they can notice and act on, not just something they might
 * eventually stumble onto. GET /api/sessions/shared-with-me already
 * existed and was already consumed by SessionMenu.tsx — but only
 * fetched once, when that dropdown happens to be opened, with no
 * indication anything changed until someone thinks to check. That's a
 * passive list, not a notification; this is the actual notification.
 *
 * Polls the same existing endpoint, deliberately not a new
 * WebSocket/SSE channel — a session share isn't time-critical enough
 * (a few seconds' delay before the toast appears is completely fine)
 * to justify the real added complexity of a push channel: mapping a
 * user id to their live connection(s), handling reconnects, and so on.
 * 10s is a reasonable balance between feeling prompt and not hammering
 * the endpoint from every open tab.
 *
 * The first poll after mount deliberately does NOT toast anything —
 * every session_id it returns becomes the baseline, not a "new" share.
 * Toasting a whole backlog of pre-existing shares the moment the app
 * loads (which is exactly what a naive "toast everything this endpoint
 * returns" implementation would do) would be noisy and, worse,
 * actually wrong: those weren't just granted, they're just
 * newly-observed by this particular poll. Only a session_id that
 * appears in a *later* poll, having not been in the previous one, is a
 * genuinely new share worth surfacing.
 */
export function ShareNotifications({ apiBase, authToken, onJoin }: Props) {
  // Renamed to `translate` specifically in this component — `t` is
  // already the conventional per-item variable name throughout this
  // file's own toast-rendering code below (dismiss(t), join(t), the
  // render map's own t.session_id etc.), and react-i18next's own
  // useTranslation() conventionally destructures its translate function
  // as `t` too. Renaming the translation function here, rather than
  // every existing toast-item reference, since the latter would be a
  // much larger, riskier change to this component's actual logic for no
  // real benefit.
  const { t: translate } = useTranslation();
  const [toasts, setToasts] = useState<SharedSession[]>([]);
  const knownSessionIdsRef = useRef<Set<string> | null>(null); // null until the baseline poll completes

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const res = await fetch(`${apiBase}/api/sessions/shared-with-me`, {
        headers: { Authorization: `Bearer ${authToken}` }
      }).catch(() => null);
      if (cancelled || !res?.ok) return;
      const shared: SharedSession[] = await res.json();
      if (cancelled) return;

      const currentIds = new Set(shared.map((s) => s.session_id));
      if (knownSessionIdsRef.current) {
        const newlyShared = shared.filter((s) => !knownSessionIdsRef.current!.has(s.session_id));
        if (newlyShared.length > 0) {
          setToasts((prev) => [...prev, ...newlyShared]);
        }
      }
      knownSessionIdsRef.current = currentIds;
    }

    poll();
    const interval = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [apiBase, authToken]);

  function dismiss(sessionId: string) {
    setToasts((prev) => prev.filter((t) => t.session_id !== sessionId));
  }

  function join(t: SharedSession) {
    onJoin(t.session_id, t.connection_id, t.protocol, t.connection_name, t.role === 'viewer');
    dismiss(t.session_id);
  }

  if (toasts.length === 0) return null;

  return (
    <div className="share-notifications">
      {toasts.map((t) => (
        <div key={t.session_id} className="share-notification">
          <div className="share-notification-text">
            {translate('share.notificationMessage', {
              owner: t.owner_username,
              protocol: t.protocol.toUpperCase(),
              connectionSuffix: t.connection_name ? ` (${t.connection_name})` : ''
            })}
          </div>
          <div className="share-notification-actions">
            <button onClick={() => join(t)}>{translate('share.join')}</button>
            <button
              className="share-notification-dismiss"
              onClick={() => dismiss(t.session_id)}
              title={translate('share.dismiss')}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
