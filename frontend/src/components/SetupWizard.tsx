import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { VersionBadge } from './VersionBadge';
import { useTheme } from '../themes/ThemeContext';

type Step = 'admin' | 'totp-enroll' | 'totp-verify' | 'vault' | 'theme' | 'done';

export function SetupWizard() {
  const { t } = useTranslation();
  const { themeId, themes, setThemeId } = useTheme();
  const [step, setStep] = useState<Step>('admin');
  const [instanceName, setInstanceName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [code, setCode] = useState('');
  const [vaultAddr, setVaultAddr] = useState('http://vault:8200');
  const [error, setError] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  // /api/setup/status issues (or returns the existing) CSRF token for this
  // session — fetched once on mount so every mutating step below can
  // attach it as a header. See services/csrf.ts for why this exists: the
  // setup wizard is the one flow authenticated by a cookie rather than a
  // Bearer token, which is what actually needs CSRF protection.
  useEffect(() => {
    fetch('/api/setup/status')
      .then((res) => res.json())
      .then((data) => setCsrfToken(data.csrfToken))
      .catch(() => {});
  }, []);

  // Renders the otpauth:// URL as an actual scannable QR code — this was
  // previously just displayed as raw text with no rendering at all (a
  // real, previously-undiscovered gap: no QR library was ever integrated,
  // not a regression in working code). The raw URL stays visible
  // underneath too, as the standard fallback for anyone who needs to
  // enter it manually rather than scan (most authenticator apps support
  // this, and it's useful if the QR fails to render for any reason).
  useEffect(() => {
    if (!otpauthUrl) return;
    QRCode.toDataURL(otpauthUrl, { width: 220, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [otpauthUrl]);

  function jsonHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    return headers;
  }

  async function submitAdmin() {
    setError(null);
    const res = await fetch('/api/setup/admin', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ username, password, instanceName })
    });
    if (!res.ok) return setError((await res.json()).message ?? t('setupWizard.createAdminError'));
    const enroll = await fetch('/api/setup/totp/enroll', { method: 'POST', headers: jsonHeaders() }).then((r) => r.json());
    setOtpauthUrl(enroll.otpauthUrl);
    setStep('totp-verify');
  }

  async function submitTotp() {
    setError(null);
    const res = await fetch('/api/setup/totp/verify', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ code })
    });
    if (!res.ok) return setError(t('twoFactorSetup.verifyFailed'));
    setStep('vault');
  }

  async function submitVault() {
    setError(null);
    const res = await fetch('/api/setup/vault', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ vaultAddr })
    });
    if (!res.ok) return setError(t('setupWizard.vaultConnectionFailed'));
    setStep('theme');
  }

  async function finishSetup() {
    await fetch('/api/setup/complete', { method: 'POST', headers: jsonHeaders() });
    setStep('done');
    window.location.href = '/login';
  }

  return (
    <div className="setup-wizard">
      <div className="setup-panel">
        <h1>{t('setupWizard.title')}</h1>

        {step === 'admin' && (
          <>
            <label>{t('setupWizard.instanceNameLabel')}<input value={instanceName} onChange={(e) => setInstanceName(e.target.value)} /></label>
            <label>{t('setupWizard.adminUsernameLabel')}<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
            <label>{t('setupWizard.adminPasswordLabel')}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <button onClick={submitAdmin}>{t('setupWizard.continue')}</button>
          </>
        )}

        {step === 'totp-verify' && (
          <>
            <p>{t('twoFactorSetup.scanHint')}</p>
            {qrDataUrl ? (
              <img className="totp-qr" src={qrDataUrl} alt={t('twoFactorSetup.qrAlt')} width={220} height={220} />
            ) : (
              <p className="admin-hint">{t('twoFactorSetup.generatingQr')}</p>
            )}
            <details className="totp-manual-entry">
              <summary>{t('twoFactorSetup.cantScan')}</summary>
              <code className="otpauth-url">
                {(() => {
                  // Most authenticator apps' manual-entry flow expects the
                  // bare base32 secret, not the full otpauth:// URL — the
                  // backend only ever sends the URL (correct: the raw
                  // secret otherwise never needs to leave the server
                  // except for this one display), so it's parsed out
                  // client-side here for a more standard experience.
                  try {
                    return new URL(otpauthUrl).searchParams.get('secret') ?? otpauthUrl;
                  } catch {
                    return otpauthUrl;
                  }
                })()}
              </code>
            </details>
            <label>{t('setupWizard.codeLabel')}<input value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <button onClick={submitTotp}>{t('setupWizard.verify')}</button>
          </>
        )}

        {step === 'vault' && (
          <>
            <label>{t('setupWizard.vaultAddressLabel')}<input value={vaultAddr} onChange={(e) => setVaultAddr(e.target.value)} placeholder="http://vault:8200" /></label>
            <p className="setup-hint">
              {t('setupWizard.vaultHint')}
            </p>
            <button onClick={submitVault}>{t('connectionForm.testConnection')}</button>
          </>
        )}

        {step === 'theme' && (
          <>
            {/* Previously just static text claiming "you can change this
                later" with no actual mechanism to do so at all — this is
                that mechanism, now real. Reuses the same useTheme() hook
                the header's own theme picker uses, so a choice made here
                sticks immediately, the same way it would from there. */}
            <p>{t('setupWizard.chooseThemeHint')}</p>
            <div className="theme-picker-grid">
              {themes.map((themeOption) => (
                <button
                  key={themeOption.id}
                  className={`theme-picker-option ${themeId === themeOption.id ? 'is-active' : ''}`}
                  onClick={() => setThemeId(themeOption.id)}
                >
                  <span className="theme-picker-name">{themeOption.name}</span>
                  <span className="theme-picker-description">{themeOption.description}</span>
                </button>
              ))}
            </div>
            <button onClick={finishSetup}>{t('setupWizard.finishSetup')}</button>
          </>
        )}

        {error && <p className="setup-error">{error}</p>}
      </div>
      <div className="setup-footer"><VersionBadge /></div>
    </div>
  );
}
