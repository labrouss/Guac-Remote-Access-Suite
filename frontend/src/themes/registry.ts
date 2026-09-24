/**
 * The list of themes selectable in the app. To add a new theme:
 *   1. Create ./your-theme-id.css defining [data-theme='your-theme-id']
 *      with all 13 properties documented in ./README.md.
 *   2. Import that file once, anywhere it'll actually be bundled (see
 *      main.tsx — every theme file is imported there, unconditionally,
 *      so its CSS is always present and switching is instant with no
 *      network request).
 *   3. Add an entry to THEMES below.
 * That's the whole contract — nothing else in the app needs to change
 * to support a new theme.
 */
export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'signal-dark',
    name: 'Signal (Dark)',
    description: 'The original theme — dark, high-contrast, network-infrastructure inspired.'
  },
  {
    id: 'daylight',
    name: 'Daylight',
    description: 'A light theme for well-lit rooms and daytime use.'
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'A deep indigo/violet dark theme — a late-night sky rather than a server rack.'
  },
  {
    id: 'comic',
    name: 'Comic',
    description: 'A bold, playful light theme — paper-cream backgrounds, thick ink borders, and Comic Sans.'
  }
];

export const DEFAULT_THEME_ID = 'signal-dark';

const STORAGE_KEY = 'guac.theme';

/**
 * Reads the saved theme id from localStorage, falling back to
 * DEFAULT_THEME_ID (Signal Dark) if unset or if it names a theme that
 * no longer exists (e.g. an old preference surviving a theme's
 * removal).
 *
 * Requested directly: this used to also check the OS's own
 * prefers-color-scheme and default to Daylight (light) for anyone
 * whose OS/browser was itself set to light mode — Windows in
 * particular very often is, by its own default — which meant "the
 * default theme" wasn't actually consistently the dark one this app
 * was designed around, for a lot of people, on first ever visit. Now
 * always the same, single default regardless of the OS's own
 * setting — an explicit, later choice (including explicitly picking a
 * theme that happens to mismatch the OS's current setting) is still
 * never second-guessed or overridden by it either, exactly as before;
 * only the *unset* case changed.
 */
export function getSavedThemeId(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && THEMES.some((t) => t.id === saved)) return saved;
  return DEFAULT_THEME_ID;
}

export function saveThemeId(id: string) {
  localStorage.setItem(STORAGE_KEY, id);
}

/**
 * Sets [data-theme] on <html>, which is all that's needed to actually
 * switch themes — every theme CSS file only ever applies under its own
 * [data-theme='...'] selector (see signal-dark.css's own comment for why
 * :root is also included there specifically, and only for the default).
 *
 * Called synchronously from main.tsx before the first render, not from
 * inside a React effect — an effect only runs after the first paint,
 * which would show a flash of the default theme before switching to a
 * saved non-default one on every load.
 */
export function applySavedTheme() {
  document.documentElement.setAttribute('data-theme', getSavedThemeId());
}
