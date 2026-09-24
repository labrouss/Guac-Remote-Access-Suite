import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { VersionBadge } from './VersionBadge';

/**
 * No way existed for any user (beyond the very first admin account,
 * enrolled inline during the setup wizard) to enable 2FA at all — this
 * is the missing general-purpose version of that same flow. Can only
 * ever be self-service: enrollment needs this user's own authenticator
 * app to scan a QR code, so there's no admin-driven equivalent for
 * *enabling* it (an admin can only clear an existing enrollment — see
 * the "reset" action next to a user's 2FA status in the admin panel).
 *
 * Deliberately stateless between enroll and verify (the encrypted secret
 * round-trips through this component rather than a server-side session)
 * — see me.ts's own comment on POST /me/totp/enroll for why: unlike the
 * setup wizard's identical-looking flow, this one is reached only via a
 * real Bearer-token-authenticated request, which doesn't reliably carry
 * a session cookie.
 */
export function TwoFactorSetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const authToken = sessionStorage.getItem('guac.sessionToken') ?? '';

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [secretEncrypted, setSecretEncrypted] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function authHeaders(json = true) {
    const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  useEffect(() => {
    fetch('/api/me', { headers: authHeaders(false) })
      .then((r) => r.json())
      .then((data) => setEnabled(!!data.totp_enabled));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Same QR rendering as SetupWizard.tsx's own identical effect.
  useEffect(() => {
    if (!otpauthUrl) return;
    QRCode.toDataURL(otpauthUrl, { width: 220, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [otpauthUrl]);

  async function startEnrollment() {
    setError(null);
    const res = await fetch('/api/me/totp/enroll', { method: 'POST', headers: authHeaders() });
    if (!res.ok) return setError(t('twoFactorSetup.enrollmentError'));
    const data = await res.json();
    setOtpauthUrl(data.otpauthUrl);
    setSecretEncrypted(data.secretEncrypted);
  }

  async function submitCode() {
    setError(null);
    const res = await fetch('/api/me/totp/verify', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ code, secretEncrypted })
    });
    if (!res.ok) return setError(t('twoFactorSetup.verifyFailed'));
    setDone(true);
  }

  return (
    <div className="setup-wizard">
      <div className="setup-panel">
        <h1>{t('twoFactorSetup.title')}</h1>

        {enabled === null && <p>{t('common.loading')}</p>}

        {enabled === true && !done && (
          <p className="setup-hint">
            {t('twoFactorSetup.alreadyEnabledHint')}
          </p>
        )}

        {enabled === false && !otpauthUrl && !done && (
          <>
            <p className="setup-hint">{t('twoFactorSetup.notSetUpHint')}</p>
            <button onClick={startEnrollment}>{t('twoFactorSetup.setUpButton')}</button>
          </>
        )}

        {otpauthUrl && !done && (
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
                  try {
                    return new URL(otpauthUrl).searchParams.get('secret') ?? otpauthUrl;
                  } catch {
                    return otpauthUrl;
                  }
                })()}
              </code>
            </details>
            <label>
              {t('twoFactorSetup.verificationCode')}
              <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            </label>
            <button onClick={submitCode}>{t('twoFactorSetup.confirmButton')}</button>
          </>
        )}

        {done && (
          <>
            <p className="setup-hint">{t('twoFactorSetup.nowEnabledHint')}</p>
            <button onClick={() => navigate('/', { replace: true })}>{t('twoFactorSetup.done')}</button>
          </>
        )}

        {error && <p className="setup-error">{error}</p>}
      </div>
      <div className="setup-footer"><VersionBadge /></div>
    </div>
  );
}
