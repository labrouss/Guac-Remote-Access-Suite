import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setLanguage } from '../i18n';

/**
 * Requested directly, alongside the "drop a file in" contribution model:
 * this never hardcodes which languages exist. It fetches /api/locales
 * (routes/locales.ts, reading its directory fresh on every request) on
 * mount, so a language someone just dropped into the locales/ directory
 * shows up here the next time this component mounts — no code change,
 * no rebuild.
 *
 * Display names use Intl.DisplayNames, a standard browser API, rather
 * than a hardcoded { en: 'English', es: 'Español', ... } map — the same
 * reasoning as not hardcoding the list of languages itself: a map would
 * need updating by hand for every new community-contributed language,
 * defeating the actual point of this feature. Falls back to the bare
 * code itself if the browser can't resolve a name for it (an
 * unrecognized or malformed code, or a very old browser without
 * Intl.DisplayNames support at all).
 */
export function LanguagePicker() {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [languages, setLanguages] = useState<string[]>([]);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/locales')
      .then((r) => (r.ok ? r.json() : { languages: [] }))
      .then((data) => setLanguages(data.languages ?? []))
      .catch(() => setLanguages([]));
  }, []);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function displayName(code: string): string {
    try {
      return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  }

  // Fewer than two real options — nothing meaningful to switch between,
  // so there's nothing worth showing at all (matches how the theme
  // picker only ever renders once its own list is populated, not a
  // disabled/empty control in the meantime).
  if (languages.length < 2) return null;

  const activeName = displayName(i18n.resolvedLanguage ?? i18n.language);

  return (
    <div className="share-session-anchor" ref={popoverRef}>
      <button className="admin-link" onClick={() => setOpen((v) => !v)}>
        {activeName}
      </button>
      {open && (
        <div className="share-popover theme-picker-grid language-picker-grid">
          {languages.map((code) => (
            <button
              key={code}
              className={`theme-picker-option ${i18n.resolvedLanguage === code ? 'is-active' : ''}`}
              onClick={() => {
                setLanguage(code);
                setOpen(false);
              }}
            >
              <span className="theme-picker-name">{displayName(code)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
