import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { VersionBadge } from './VersionBadge';
import { loginWithPasskey, browserSupportsWebAuthn } from '../lib/webauthn';

type Stage = 'credentials' | 'totp';

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>('credentials');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pendingToken, setPendingToken] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sessionExpiredNotice, setSessionExpiredNotice] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  // authFetchInterceptor.ts sets this flag right before redirecting here,
  // specifically so this lands as a clear notice rather than a person
  // just finding themselves back at a blank login form with no
  // explanation for why. Read once on mount and cleared immediately —
  // an ordinary, voluntary sign-out later in the same tab (or a fresh
  // visit after actually re-authenticating) should never show a stale
  // notice from a previous expiry.
  useEffect(() => {
    const reason = sessionStorage.getItem('guac.sessionExpiredReason');
    if (reason === 'inactivity') {
      setSessionExpiredNotice(t('login.sessionExpiredInactivity'));
    } else if (reason === 'server') {
      setSessionExpiredNotice(t('login.sessionExpiredServer'));
    }
    sessionStorage.removeItem('guac.sessionExpiredReason');
    // t deliberately omitted from deps — this reads a one-shot flag
    // exactly once, on mount; re-running it if the language changes
    // later in the same visit would re-show a notice that already did
    // its job and was already cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function afterLoginSuccess(sessionToken: string, mustChangePassword: boolean) {
    sessionStorage.setItem('guac.sessionToken', sessionToken);
    navigate(mustChangePassword ? '/change-password' : '/', { replace: true });
  }

  async function submitCredentials() {
    setError(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    // data.message is a real, specific server-provided reason when present
    // (e.g. "account disabled") — left untranslated deliberately, since
    // translating arbitrary backend-generated text would need the backend
    // itself to be locale-aware, out of scope for this pass (see
    // locales/README.md). t('login.invalidCredentials') is only the
    // generic fallback for when the server didn't send anything more
    // specific.
    if (!res.ok) return setError(data.message ?? t('login.invalidCredentials'));

    if (data.requiresTotp) {
      setPendingToken(data.pendingToken);
      setStage('totp');
    } else {
      afterLoginSuccess(data.sessionToken, data.mustChangePassword);
    }
  }

  async function submitTotp() {
    setError(null);
    const res = await fetch('/api/auth/login/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingToken, code })
    });
    const data = await res.json();
    if (!res.ok) return setError(data.message ?? t('login.invalidCode'));
    afterLoginSuccess(data.sessionToken, data.mustChangePassword);
  }

  async function submitPasskey() {
    setError(null);
    setPasskeyBusy(true);
    try {
      const data = await loginWithPasskey();
      afterLoginSuccess(data.sessionToken, data.mustChangePassword);
    } catch (err: any) {
      // A cancelled prompt is shown the same as any other passkey
      // outcome here rather than silently swallowed — staying on the
      // credentials form with no feedback at all would leave someone
      // who meant to cancel wondering whether anything happened.
      // err.serverMessage (a real, specific reason from the backend) is
      // shown verbatim, untranslated, the same precedent
      // submitCredentials above already established for password login;
      // err.code is this app's own client-side text, translated here.
      if (err?.serverMessage) {
        setError(err.serverMessage);
      } else if (err?.code === 'cancelled') {
        setError(t('login.passkeyCancelled'));
      } else {
        setError(t('login.passkeyFailed'));
      }
    } finally {
      setPasskeyBusy(false);
    }
  }

  return (
    <div className="setup-wizard">
      <div className="setup-panel">
        <h1>{t('login.title')}</h1>

        {sessionExpiredNotice && <p className="setup-hint">{sessionExpiredNotice}</p>}

        {stage === 'credentials' && (
          <>
            <label>
              {t('login.username')}
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </label>
            <label>
              {t('login.password')}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitCredentials()}
              />
            </label>
            <button onClick={submitCredentials}>{t('common.signIn')}</button>

            {browserSupportsWebAuthn() && (
              <button type="button" className="add-connection-cancel" onClick={submitPasskey} disabled={passkeyBusy}>
                {passkeyBusy ? t('login.passkeyWorking') : t('login.signInWithPasskey')}
              </button>
            )}
          </>
        )}

        {stage === 'totp' && (
          <>
            <label>
              {t('login.totpLabel')}
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitTotp()}
                autoFocus
              />
            </label>
            <button onClick={submitTotp}>{t('login.verify')}</button>
          </>
        )}

        {error && <p className="setup-error">{error}</p>}
      </div>
      <div className="setup-footer"><VersionBadge /></div>
    </div>
  );
}
