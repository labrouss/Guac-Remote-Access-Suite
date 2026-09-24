import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { VersionBadge } from './VersionBadge';
import { registerPasskey, browserSupportsWebAuthn, isSecureContext, PasskeyError } from '../lib/webauthn';

interface Passkey {
  id: string;
  name: string;
  device_type: string;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('guac.sessionToken') ?? ''}` };
}

export function PasskeySettingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    fetch('/api/me/passkeys', { headers: authHeaders() })
      .then((r) => r.json())
      .then(setPasskeys)
      .catch(() => setError(t('passkeys.loadError')));
  }
  useEffect(refresh, []);

  async function addPasskey() {
    if (!newName.trim()) {
      setError(t('passkeys.nameRequired'));
      return;
    }
    setError(null);
    setAdding(true);
    try {
      await registerPasskey('', sessionStorage.getItem('guac.sessionToken') ?? '', newName.trim());
      setNewName('');
      refresh();
    } catch (err) {
      const passkeyErr = err instanceof PasskeyError ? err : null;
      if (passkeyErr?.serverMessage) {
        setError(passkeyErr.serverMessage);
      } else if (passkeyErr?.code === 'cancelled') {
        setError(t('passkeys.cancelled'));
      } else {
        setError(t('passkeys.addFailed'));
      }
    } finally {
      setAdding(false);
    }
  }

  async function removePasskey(id: string) {
    if (!confirm(t('passkeys.removeConfirm'))) return;
    const res = await fetch(`/api/me/passkeys/${id}`, { method: 'DELETE', headers: authHeaders() });
    if (!res.ok) {
      setError(t('passkeys.removeFailed'));
      return;
    }
    refresh();
  }

  return (
    <div className="setup-wizard">
      <div className="setup-panel">
        <h1>{t('passkeys.title')}</h1>
        <p className="setup-hint">{t('passkeys.hint')}</p>

        {!isSecureContext() ? (
          <p className="setup-error">{t('passkeys.insecureContext')}</p>
        ) : (
          !browserSupportsWebAuthn() && <p className="setup-error">{t('passkeys.unsupportedBrowser')}</p>
        )}

        {passkeys === null && <p>{t('common.loading')}</p>}

        {passkeys && passkeys.length > 0 && (
          <ul className="admin-folders-list">
            {passkeys.map((p) => (
              <li key={p.id}>
                <span>
                  {p.name}{' '}
                  <span className="admin-hint">
                    {p.last_used_at
                      ? t('passkeys.lastUsed', { date: new Date(p.last_used_at).toLocaleString(i18n.language) })
                      : t('passkeys.neverUsed')}
                  </span>
                </span>
                <button onClick={() => removePasskey(p.id)}>{t('passkeys.remove')}</button>
              </li>
            ))}
          </ul>
        )}
        {passkeys && passkeys.length === 0 && <p className="admin-hint">{t('passkeys.noneYet')}</p>}

        {isSecureContext() && browserSupportsWebAuthn() && (
          <div className="admin-form-row">
            <input
              placeholder={t('passkeys.namePlaceholder')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button onClick={addPasskey} disabled={adding}>
              {adding ? t('passkeys.adding') : t('passkeys.addButton')}
            </button>
          </div>
        )}

        {error && <p className="setup-error">{error}</p>}

        <button className="add-connection-cancel" onClick={() => navigate('/', { replace: true })}>
          {t('common.close')}
        </button>
      </div>
      <div className="setup-footer"><VersionBadge /></div>
    </div>
  );
}
