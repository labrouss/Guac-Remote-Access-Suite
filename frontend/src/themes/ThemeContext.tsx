import { createContext, useContext, useState, ReactNode } from 'react';
import { getSavedThemeId, saveThemeId, THEMES, ThemeDefinition } from './registry';

interface ThemeContextValue {
  themeId: string;
  themes: ThemeDefinition[];
  setThemeId: (id: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Wraps the app so any component (a theme picker in the header, the
 * setup wizard's own theme step, a future settings page) can read the
 * current theme and change it reactively. The actual application of a
 * theme to the page — setting [data-theme] on <html> — already happened
 * once, synchronously, in main.tsx before this even mounts (see
 * registry.ts's applySavedTheme for why that has to happen there and
 * not here). This provider's job is purely to keep React's own state in
 * sync with that after a change, and to persist the choice.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeIdState] = useState(getSavedThemeId);

  function setThemeId(id: string) {
    document.documentElement.setAttribute('data-theme', id);
    saveThemeId(id);
    setThemeIdState(id);
  }

  return (
    <ThemeContext.Provider value={{ themeId, themes: THEMES, setThemeId }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
