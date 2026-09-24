import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import HttpBackend from 'i18next-http-backend';

const STORAGE_KEY = 'guac.language';

/**
 * Requested directly: new languages should become available by dropping a
 * file into a directory, not by registering them anywhere in this
 * codebase or rebuilding the frontend. i18next-http-backend fetches
 * translation JSON from the backend's own /api/locales/:lang endpoint at
 * runtime — nothing is statically imported or bundled, so a file the
 * backend can already see (routes/locales.ts reads its directory fresh on
 * every request) is immediately available here too, with no build step in
 * between. See locales/README.md at the repo root for the actual
 * contribution workflow this enables.
 *
 * fallbackLng: 'en' means a partial translation never breaks the UI — any
 * key missing from a language file falls back to the English one
 * automatically, so a community contributor can translate a handful of
 * keys and stop there without leaving blank text anywhere.
 *
 * Requested directly, made explicit rather than left implicit: the
 * default language, for anyone who hasn't ever picked one in this
 * browser, is always English — never the browser's own language
 * setting. Passing 'en' directly here (rather than the previous
 * `?? undefined`, relying on i18next's own fallbackLng taking over
 * when no lng is given at all) makes that guarantee explicit and
 * direct, not dependent on i18next's own particular behavior for an
 * unset lng continuing to work the same way it does today — this app
 * has never used i18next-browser-languagedetector or any other
 * browser-language-sniffing mechanism, and an explicit default here
 * keeps that true even if one were ever added later for some other
 * reason.
 *
 * The saved language, like the saved theme (see themes/registry.ts's own
 * applySavedTheme), is a per-browser localStorage preference, not
 * anything server-side — consistent with how this app already handles
 * personal display preferences.
 */
export function initI18n() {
  return i18n
    .use(HttpBackend)
    .use(initReactI18next)
    .init({
      lng: localStorage.getItem(STORAGE_KEY) ?? 'en',
      fallbackLng: 'en',
      supportedLngs: false, // discovered at runtime (LanguagePicker's own /api/locales fetch), not a fixed list here
      backend: {
        // Same-origin as every other fetch in this app (see AppShell.tsx's
        // own API_BASE constant) — nginx proxies /api to the backend, so
        // no base URL needs configuring here at all.
        loadPath: '/api/locales/{{lng}}'
      },
      interpolation: { escapeValue: false }, // React already escapes output — i18next's own escaping would double-escape it
      react: { useSuspense: false } // avoids needing a <Suspense> boundary wrapped around the entire app for this
    });
}

/** Persists the choice and actually switches the active language — used by
 * LanguagePicker.tsx. Kept here, next to STORAGE_KEY, rather than
 * duplicating the key string in the component itself. */
export function setLanguage(lang: string) {
  localStorage.setItem(STORAGE_KEY, lang);
  i18n.changeLanguage(lang);
}

export function getSavedLanguage(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export default i18n;
