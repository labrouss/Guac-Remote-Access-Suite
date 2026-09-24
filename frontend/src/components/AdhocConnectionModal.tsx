import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface AdhocSettings {
  protocol: string;
  hostname: string;
  port: number;
  username: string;
  password: string;
  params?: Record<string, unknown>;
}

interface Props {
  apiBase: string;
  authToken: string;
  onClose: () => void;
  onConnect: (settings: AdhocSettings) => void;
}

const PROTOCOL_DEFAULT_PORTS: Record<string, number> = {
  ssh: 22,
  rdp: 3389,
  vnc: 5900
};

function authHeaders(authToken: string) {
  return { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' };
}

/**
 * Requested directly: an ad-hoc connection, the same thing Guacamole
 * itself supports natively — fill in connection details and connect
 * immediately, with nothing saved as a reusable connection record at
 * all. Deliberately admin-only: every other connection in this app is
 * reachable only because an admin explicitly granted it through the
 * list-based permission model, and an ad-hoc connection has no saved
 * record to check permissions against — see
 * issueAdhocConnectionToken's own comment (routes/tunnelToken.ts) for
 * the full reasoning. That's enforced there, server-side, independent
 * of whether this modal is even reachable in the UI at all; the trigger
 * button that opens this (AppShell.tsx) is also hidden for a non-admin,
 * but that's a UX nicety on top of the real enforcement, not a
 * substitute for it.
 *
 * Deliberately does NOT write anything to connection_credentials or
 * Vault — the credentials typed in here exist only long enough to reach
 * the token endpoint and get baked into one short-lived, encrypted
 * token; nothing about this modal, or the backend route it calls,
 * persists them anywhere at all.
 *
 * Modeled closely on AddConnectionForm's own fields (protocol, host,
 * port with per-protocol default, credentials) and
 * EditConnectionModal's own ignore-cert/advanced-parameters pattern —
 * `ignore-cert` is a real Guacamole RDP protocol parameter (see that
 * component's own comment), not something invented for this modal.
 * Genuinely does not save a connection at all — "Connect" calls
 * onConnect directly with the filled-in settings, for the caller
 * (AppShell.tsx) to open a new session tab from immediately, the same
 * way opening any other connection already works.
 */
export function AdhocConnectionModal({ apiBase, authToken, onClose, onConnect }: Props) {
  const { t } = useTranslation();
  const [protocol, setProtocol] = useState('ssh');
  const [hostname, setHostname] = useState('');
  const [port, setPort] = useState(PROTOCOL_DEFAULT_PORTS.ssh);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [ignoreCert, setIgnoreCert] = useState(false);
  const [advancedParams, setAdvancedParams] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ reachable: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  function onProtocolChange(next: string) {
    setProtocol(next);
    setPort(PROTOCOL_DEFAULT_PORTS[next] ?? port);
    setTestResult(null); // stale once hostname/port context changes
  }

  async function testConnection() {
    if (!hostname.trim()) {
      setTestResult({ reachable: false, message: t('adhocConnect.enterHostnameFirst') });
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
      setTestResult({ reachable: false, message: t('adhocConnect.testRunError') });
    } finally {
      setTesting(false);
    }
  }

  function connect() {
    setError(null);
    if (!hostname.trim()) {
      setError(t('adhocConnect.hostnameRequired'));
      return;
    }
    let parsedAdvanced: Record<string, unknown> = {};
    if (advancedParams.trim()) {
      try {
        parsedAdvanced = JSON.parse(advancedParams);
      } catch {
        setError(t('adhocConnect.advancedParamsInvalid'));
        return;
      }
    }
    const params = { ...parsedAdvanced, ...(ignoreCert ? { 'ignore-cert': true } : {}) };
    onConnect({ protocol, hostname: hostname.trim(), port, username, password, params });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <h3>{t('adhocConnect.title')}</h3>
        <p className="setup-hint">
          {t('adhocConnect.hint')}
        </p>

        <div className="add-connection-form-row">
          <select value={protocol} onChange={(e) => onProtocolChange(e.target.value)}>
            <option value="ssh">SSH</option>
            <option value="rdp">RDP</option>
            <option value="vnc">VNC</option>
          </select>
        </div>
        <div className="add-connection-form-row">
          <input
            placeholder={t('adhocConnect.hostnamePlaceholder')}
            value={hostname}
            onChange={(e) => {
              setHostname(e.target.value);
              setTestResult(null);
            }}
          />
          <input
            placeholder={t('adhocConnect.portPlaceholder')}
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
            {testing ? t('adhocConnect.testing') : t('adhocConnect.testConnection')}
          </button>
          {testResult && (
            <span className={testResult.reachable ? 'cred-status-ok' : 'cred-status-missing'}>
              {testResult.reachable ? t('adhocConnect.reachable') : `✗ ${testResult.message}`}
            </span>
          )}
        </div>
        <div className="add-connection-form-row">
          <input placeholder={t('adhocConnect.usernamePlaceholder')} value={username} onChange={(e) => setUsername(e.target.value)} />
          <input
            placeholder={t('adhocConnect.passwordPlaceholder')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {protocol === 'rdp' && (
          <label className="admin-checkbox">
            <input type="checkbox" checked={ignoreCert} onChange={(e) => setIgnoreCert(e.target.checked)} />
            {t('admin.listDetail.ignoreCertErrors')}
          </label>
        )}

        <details className="advanced-params-details">
          <summary>{t('adhocConnect.advancedParameters')}</summary>
          <textarea
            className="advanced-params-textarea"
            placeholder='{"security": "nla"}'
            value={advancedParams}
            onChange={(e) => setAdvancedParams(e.target.value)}
          />
        </details>

        {error && <p className="setup-error">{error}</p>}

        <div className="add-connection-form-actions">
          <button onClick={connect}>{t('common.connect')}</button>
          <button className="add-connection-cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
