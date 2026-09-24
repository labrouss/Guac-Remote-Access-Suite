import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  listId: string;
  apiBase: string;
  authToken: string;
  onCreated: () => void;
  /** Real, standalone folder entities (migration 018) — every folder
   * that exists in this list, for the dropdown below. See
   * EditConnectionModal.tsx's identical prop.
   */
  folders?: { id: string; name: string }[];
}

const PROTOCOL_DEFAULT_PORTS: Record<string, number> = {
  ssh: 22,
  rdp: 3389,
  vnc: 5900,
  telnet: 23,
  kubernetes: 443
};

/**
 * The regular-user-facing counterpart to AdminPanel.tsx's own connection
 * form — that one already existed and works correctly
 * (POST /api/admin/lists/:listId/connections only requires 'edit'
 * permission on the list, not admin-only), but nothing in the ordinary
 * ConnectionPanel let anyone actually reach it. Found live: AdminPanel's
 * own help text explicitly promises "[users] can add connections and set
 * their own credentials there without needing anything from an admin" —
 * a promise the UI never actually kept.
 *
 * Creates the connection and writes its credentials in one flow — for
 * the personal-list case this component is mainly for, shared vs
 * individual credential mode makes little difference (there's only one
 * user), so defaulting to shared and setting the credential immediately
 * avoids a separate, easy-to-miss second step before the connection is
 * actually usable.
 */
export function AddConnectionForm({ listId, apiBase, authToken, onCreated, folders }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState('ssh');
  const [hostname, setHostname] = useState('');
  const [port, setPort] = useState(PROTOCOL_DEFAULT_PORTS.ssh);
  const [credentialMode, setCredentialMode] = useState<'shared' | 'individual' | 'ad_passthrough'>('shared');
  const [folderId, setFolderId] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ reachable: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  function authHeaders() {
    return { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' };
  }

  // Same reasoning as EditConnectionModal.tsx's own identical effect:
  // "AD passthrough" is only ever offered as an option once this
  // confirms AD is actually configured on this deployment — offering it
  // otherwise would be actively misleading, since it could never work.
  const [adEnabled, setAdEnabled] = useState(false);
  useEffect(() => {
    fetch(`${apiBase}/api/admin/ad-status`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((data) => setAdEnabled(Boolean(data.enabled)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, authToken]);

  function onProtocolChange(next: string) {
    setProtocol(next);
    setPort(PROTOCOL_DEFAULT_PORTS[next] ?? port);
    setTestResult(null); // stale once hostname/port context changes
  }

  async function testConnection() {
    if (!hostname.trim()) {
      setTestResult({ reachable: false, message: t('connectionForm.enterHostnameFirst') });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${apiBase}/api/connections/test-reachability`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ hostname, port })
      });
      const result = await res.json();
      setTestResult(result);
    } catch {
      setTestResult({ reachable: false, message: t('connectionForm.testRunError') });
    } finally {
      setTesting(false);
    }
  }

  async function submit() {
    setError(null);
    if (!name.trim() || !hostname.trim()) {
      setError(t('addConnectionForm.nameHostnameRequired'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/admin/lists/${listId}/connections`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name, protocol, hostname, port, credentialMode, forceRecord: false, folderId: folderId || null })
      });
      if (!res.ok) {
        setError(t('addConnectionForm.createError'));
        return;
      }
      const { id } = await res.json();

      // Credentials are optional here — a connection with none configured
      // simply can't be opened yet (a clear "no credentials configured"
      // error from the backend), rather than this form forcing them in
      // up front. Useful if you want to create the connection now and
      // set real credentials later.
      if (username || password) {
        await fetch(`${apiBase}/api/credentials/${id}`, {
          method: 'PUT',
          headers: authHeaders(),
          body: JSON.stringify({ username, secret: password })
        });
      }

      setName('');
      setHostname('');
      setUsername('');
      setPassword('');
      setTestResult(null);
      setFolderId('');
      setOpen(false);
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button className="add-connection-trigger" onClick={() => setOpen(true)}>
        {t('addConnectionForm.trigger')}
      </button>
    );
  }

  return (
    <div className="add-connection-form">
      <div className="add-connection-form-row">
        <input placeholder={t('connectionForm.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
        <select value={protocol} onChange={(e) => onProtocolChange(e.target.value)}>
          <option value="ssh">SSH</option>
          <option value="rdp">RDP</option>
          <option value="vnc">VNC</option>
          <option value="telnet">Telnet</option>
          <option value="kubernetes">Kubernetes</option>
        </select>
      </div>
      <div className="add-connection-form-row">
        <input
          placeholder={t('connectionForm.hostnamePlaceholder')}
          value={hostname}
          onChange={(e) => {
            setHostname(e.target.value);
            setTestResult(null);
          }}
        />
        <input
          placeholder={t('connectionForm.portPlaceholder')}
          type="number"
          value={port}
          onChange={(e) => {
            setPort(Number(e.target.value));
            setTestResult(null);
          }}
        />
      </div>
      <div className="add-connection-form-row">
        <button type="button" onClick={testConnection} disabled={testing} className="add-connection-cancel">
          {testing ? t('connectionForm.testing') : t('connectionForm.testConnection')}
        </button>
        {testResult && (
          <span className={testResult.reachable ? 'cred-status-ok' : 'cred-status-missing'}>
            {testResult.reachable ? t('connectionForm.reachable') : `✗ ${testResult.message}`}
          </span>
        )}
      </div>
      {credentialMode !== 'ad_passthrough' && (
        <div className="add-connection-form-row">
          <input placeholder={t('connectionForm.usernamePlaceholder')} value={username} onChange={(e) => setUsername(e.target.value)} />
          <input
            placeholder={t('connectionForm.passwordPlaceholder')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      )}
      <div className="add-connection-form-row">
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">{t('connectionForm.noFolder')}</option>
          {(folders ?? []).map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
      </div>
      <label className="admin-checkbox">
        {t('editConnectionModal.credentialModeLabel')}
        <select value={credentialMode} onChange={(e) => setCredentialMode(e.target.value as typeof credentialMode)}>
          <option value="shared">{t('editConnectionModal.sharedOption')}</option>
          <option value="individual">{t('editConnectionModal.individualOption')}</option>
          {adEnabled && <option value="ad_passthrough">{t('editConnectionModal.adPassthroughOption')}</option>}
        </select>
      </label>
      {error && <p className="setup-error">{error}</p>}
      <div className="add-connection-form-actions">
        <button onClick={submit} disabled={saving}>
          {saving ? t('addConnectionForm.creating') : t('addConnectionForm.create')}
        </button>
        <button className="add-connection-cancel" onClick={() => setOpen(false)} disabled={saving}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
