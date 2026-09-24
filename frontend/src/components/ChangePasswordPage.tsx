import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { VersionBadge } from './VersionBadge';

export function ChangePasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [required, setRequired] = useState(false);

  const authToken = sessionStorage.getItem('guac.sessionToken') ?? '';

  useEffect(() => {
    fetch('/api/me', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => setRequired(!!data.must_change_password));
  }, [authToken]);

  async function submit() {
    setError(null);
    if (newPassword !== confirmPassword) return setError(t('changePassword.mismatch'));

    const res = await fetch('/api/me/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();
    if (!res.ok) return setError(data.message ?? t('changePassword.changeFailed'));
    navigate('/', { replace: true });
  }

  return (
    <div className="setup-wizard">
      <div className="setup-panel">
        <h1>{required ? t('changePassword.titleSet') : t('changePassword.titleChange')}</h1>
        {required && (
          <p className="setup-hint">
            {t('changePassword.requiredHint')}
          </p>
        )}

        <label>
          {t('changePassword.currentPassword')}
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoFocus />
        </label>
        <label>
          {t('changePassword.newPassword')}
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        </label>
        <label>
          {t('changePassword.confirmNewPassword')}
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
        </label>
        <button onClick={submit}>{t('common.save')}</button>

        {error && <p className="setup-error">{error}</p>}
      </div>
      <div className="setup-footer"><VersionBadge /></div>
    </div>
  );
}
