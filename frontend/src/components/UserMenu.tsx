import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

interface Props {
  apiBase: string;
  authToken: string;
  onSignOut: () => void;
}

/**
 * Requested directly: was four separate header links
 * (change-password/two-factor/passkeys/sign-out) crowding the header
 * bar, one per personal-account action — consolidated into a single
 * trigger showing the signed-in username, opening a dropdown with all
 * four, freeing that header space for feature buttons instead. Same
 * dropdown shape (positioning, outside-click/Escape-to-close) as
 * SessionMenu.tsx's own, established pattern — reused rather than
 * inventing a second one.
 *
 * Menu entries are buttons (useNavigate on click), not <Link>s — asked
 * for directly as a follow-up, so every item in the menu behaves and
 * looks the same way regardless of whether it navigates (three of
 * these) or acts in place (sign-out, which always was a button).
 *
 * Fully self-contained (fetches its own username, owns its own
 * open/closed state) unlike SessionMenu, which needs its parent's own
 * session state — nothing here needs to be known outside this
 * component, so AppShell.tsx doesn't need a menu-open state variable
 * of its own for this the way it does for the session menu.
 */
export function UserMenu({ apiBase, authToken, onSignOut }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/api/me`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUsername(data?.username ?? null));
  }, [apiBase, authToken]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function go(path: string) {
    setOpen(false);
    navigate(path);
  }

  return (
    <div className="session-menu-anchor" ref={menuRef}>
      <button className="admin-link session-menu-trigger" onClick={() => setOpen((v) => !v)}>
        {username ?? '\u2026'} ▾
      </button>
      {open && (
        <div className="session-menu user-menu">
          <button className="session-menu-item" onClick={() => go('/change-password')}>
            {t('header.changePassword')}
          </button>
          <button className="session-menu-item" onClick={() => go('/two-factor')}>
            {t('header.twoFactorAuth')}
          </button>
          <button className="session-menu-item" onClick={() => go('/passkeys')}>
            {t('header.passkeys')}
          </button>
          <div className="user-menu-divider" />
          <button className="session-menu-item user-menu-signout" onClick={onSignOut}>
            {t('common.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}
