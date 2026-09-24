import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ConnectionRow {
  id: string;
  name: string;
  protocol: string;
  hostname: string;
  port: number;
  force_record: boolean;
  credential_mode?: 'shared' | 'individual' | 'ad_passthrough';
  params?: Record<string, unknown>;
  folder_id?: string | null;
}

interface Props {
  apiBase: string;
  authToken: string;
  connection: ConnectionRow;
  onClose: () => void;
  onSaved: () => void;
  /** Real, standalone folder entities (migration 018) — every folder
   * that exists in this list, for the dropdown below. Genuinely
   * different from the earlier free-text version: a folder can now
   * exist here even with zero connections currently assigned to it.
   */
  folders?: { id: string; name: string }[];
}

function authHeaders(authToken: string) {
  return { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' };
}

/**
 * The edit half of connection management — creation already existed
 * (AdminPanel.tsx's own form), but there was no way to change anything
 * about a connection afterward, or to ever set/update its credentials
 * outside the moment it was first created. That gap is exactly why
 * connections created through the admin form (which never had
 * credential fields at all — only AddConnectionForm.tsx's newer,
 * regular-user-facing form does) could never actually be connected to:
 * confirmed live as a 409 no_credentials_configured on every attempt.
 *
 * `ignore-cert` isn't a made-up option — it's a real Guacamole RDP
 * protocol parameter, confirmed by checking how the `params` column
 * actually flows through (routes/tunnelToken.ts spreads it directly into
 * the settings object sent to guacd), so this checkbox needed no backend
 * changes at all to work. The advanced-parameters textarea underneath
 * it is a deliberate escape hatch rather than trying to hardcode a
 * dropdown for every protocol-specific Guacamole option that might ever
 * be wanted — it edits the same underlying `params` object directly.
 */
export function EditConnectionModal({ apiBase, authToken, connection, onClose, onSaved, folders }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(connection.name);
  const [hostname, setHostname] = useState(connection.hostname);
  const [port, setPort] = useState(connection.port);
  const [forceRecord, setForceRecord] = useState(connection.force_record);
  // Requested directly: no way existed to change this after creation —
  // only AddConnectionForm.tsx's own create-time checkbox could set it
  // at all. Defaults to the connection's current mode, matching every
  // other field in this form.
  //
  // A dropdown, not the original checkbox — a checkbox can only ever
  // represent two states, and this now has three (shared/individual/
  // ad_passthrough).
  const [credentialMode, setCredentialMode] = useState<'shared' | 'individual' | 'ad_passthrough'>(
    connection.credential_mode === 'individual' || connection.credential_mode === 'ad_passthrough'
      ? connection.credential_mode
      : 'shared'
  );
  // Gates whether "AD passthrough" is even offered as an option at all
  // — GET /api/admin/ad-status, not assumed true: offering it on a
  // deployment with no AD configured would be actively misleading,
  // since it could never actually work there. Fetched once, on mount;
  // this doesn't change while the modal is open.
  const [adEnabled, setAdEnabled] = useState(false);
  useEffect(() => {
    fetch(`${apiBase}/api/admin/ad-status`, { headers: authHeaders(authToken) })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((data) => setAdEnabled(Boolean(data.enabled)));
  }, [apiBase, authToken]);
  const [folderId, setFolderId] = useState(connection.folder_id ?? '');
  const [ignoreCert, setIgnoreCert] = useState(Boolean(connection.params?.['ignore-cert']));
  const [advancedParams, setAdvancedParams] = useState(() => {
    const { 'ignore-cert': _ignore, ...rest } = connection.params ?? {};
    return Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : '';
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ reachable: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

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
        headers: authHeaders(authToken),
        body: JSON.stringify({ hostname, port })
      });
      setTestResult(await res.json());
    } catch {
      setTestResult({ reachable: false, message: t('connectionForm.testRunError') });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setError(null);
    let parsedAdvanced: Record<string, unknown> = {};
    if (advancedParams.trim()) {
      try {
        parsedAdvanced = JSON.parse(advancedParams);
      } catch {
        setError(t('editConnectionModal.advancedParamsInvalid'));
        return;
      }
    }

    setSaving(true);
    try {
      const params = { ...parsedAdvanced, ...(ignoreCert ? { 'ignore-cert': true } : {}) };
      const res = await fetch(`${apiBase}/api/admin/connections/${connection.id}`, {
        method: 'PUT',
        headers: authHeaders(authToken),
        body: JSON.stringify({ name, hostname, port, forceRecord, params, folderId: folderId || null, credentialMode })
      });
      if (!res.ok) {
        setError(t('editConnectionModal.saveError'));
        return;
      }

      if (username || password) {
        const credRes = await fetch(`${apiBase}/api/credentials/${connection.id}`, {
          method: 'PUT',
          headers: authHeaders(authToken),
          body: JSON.stringify({ username, secret: password })
        });
        if (!credRes.ok) {
          setError(t('editConnectionModal.credentialsUpdateFailed'));
          return;
        }
      }

      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <h3>{t('editConnectionModal.title', { name: connection.name })}</h3>
        <div className="admin-form-row admin-form-row-stacked">
          <label>{t('connectionForm.namePlaceholder')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>{t('connectionForm.hostnamePlaceholder')}<input value={hostname} onChange={(e) => { setHostname(e.target.value); setTestResult(null); }} /></label>
          <label>
            {t('connectionForm.portPlaceholder')}
            <input type="number" value={port} onChange={(e) => { setPort(Number(e.target.value)); setTestResult(null); }} />
          </label>
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
          <label className="admin-checkbox">
            <input type="checkbox" checked={forceRecord} onChange={(e) => setForceRecord(e.target.checked)} />
            {t('editConnectionModal.forceRecording')}
          </label>

          <label>
            {t('editConnectionModal.credentialModeLabel')}
            <select value={credentialMode} onChange={(e) => setCredentialMode(e.target.value as typeof credentialMode)}>
              <option value="shared">{t('editConnectionModal.sharedOption')}</option>
              <option value="individual">{t('editConnectionModal.individualOption')}</option>
              {(adEnabled || connection.credential_mode === 'ad_passthrough') && (
                <option value="ad_passthrough">{t('editConnectionModal.adPassthroughOption')}</option>
              )}
            </select>
          </label>

          <label>
            {t('editConnectionModal.folderLabel')}
            <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">— none —</option>
              {(folders ?? []).map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </label>

          {connection.protocol === 'rdp' && (
            <label className="admin-checkbox">
              <input type="checkbox" checked={ignoreCert} onChange={(e) => setIgnoreCert(e.target.checked)} />
              {t('editConnectionModal.ignoreCertErrors')}
            </label>
          )}

          <label>
            {t('editConnectionModal.advancedParamsLabel', { example: '{"security": "nla"}' })}
            <textarea
              className="advanced-params-textarea"
              rows={3}
              value={advancedParams}
              onChange={(e) => setAdvancedParams(e.target.value)}
              placeholder='{"resize-method": "display-update"}'
            />
          </label>

          <h4>{t('editConnectionModal.updateCredentials')}</h4>
          <p className="setup-hint">
            {credentialMode === 'ad_passthrough'
              ? t('editConnectionModal.adPassthroughHint')
              : credentialMode === 'individual'
                ? t('editConnectionModal.individualModeHint')
                : t('editConnectionModal.sharedModeHint')}
          </p>
          {credentialMode !== 'ad_passthrough' && (
            <>
              <label>{t('connectionForm.usernamePlaceholder')}<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
              <label>
                {t('connectionForm.passwordPlaceholder')}
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
            </>
          )}
        </div>

        {error && <p className="setup-error">{error}</p>}

        <div className="add-connection-form-actions">
          <button onClick={save} disabled={saving}>{saving ? t('editConnectionModal.saving') : t('common.save')}</button>
          <button className="add-connection-cancel" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  );
}
