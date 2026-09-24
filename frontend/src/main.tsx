import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme.css';
import './themes/signal-dark.css';
import './themes/daylight.css';
import './themes/midnight.css';
import './themes/comic.css';
import { applySavedTheme } from './themes/registry';
import { installAuthFetchInterceptor, startIdleExpiryWatcher } from './lib/authFetchInterceptor';
import { installActivityTracker } from './lib/activityTracker';
import { initI18n } from './i18n';

// Applied synchronously, before the first render — not from inside a
// React effect, which only runs after the first paint and would show a
// flash of the default theme before switching to a saved non-default
// one on every load. See themes/registry.ts's own comment on
// applySavedTheme for the full reasoning.
applySavedTheme();

// Also installed before the first render, for the same reason a fetch
// happening before this ran would slip through uncaught — see
// authFetchInterceptor.ts's own comment for the full reasoning.
installAuthFetchInterceptor();

// Idle-session-timeout support: installActivityTracker attaches its own
// document-level listeners once and is harmless before login (nothing
// is stored in sessionStorage to compare against yet); startIdleExpiryWatcher's
// periodic check simply finds no token and does nothing until there is
// one. Both installed unconditionally here, same as
// installAuthFetchInterceptor above, rather than only after a
// successful login — see authFetchInterceptor.ts's own comment for the
// full reasoning behind the feature itself.
installActivityTracker();
startIdleExpiryWatcher();

// Awaited before the first render, same reasoning as applySavedTheme
// above — react-i18next runs with useSuspense: false (see i18n.ts's own
// comment on why), which means a component using useTranslation() before
// its language has finished loading would briefly render the raw
// translation key itself rather than real text. Waiting here means the
// very first render already has the right language loaded, not a flash
// of keys followed by a re-render once it arrives.
initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(<App />);
});
