import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../themes/ThemeContext';

/**
 * The header-accessible way to change themes later, fulfilling what the
 * setup wizard's own theme step already claims ("You can change this
 * later") — a claim that had no actual mechanism behind it at all before
 * this. No onVisibilityChange wiring needed here unlike
 * ShareSessionButton's identical-looking popover: this one has no text
 * input inside it, just buttons, and mouse clicks were never affected by
 * a session's Guacamole.Keyboard capturing keystrokes in the first
 * place — only actual typing was ever at risk from that bug.
 */
export function ThemePicker() {
  const { themeId, themes, setThemeId } = useTheme();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const activeTheme = themes.find((t) => t.id === themeId);

  return (
    <div className="share-session-anchor" ref={popoverRef}>
      <button className="admin-link" onClick={() => setOpen((v) => !v)}>
        Theme{activeTheme ? `: ${activeTheme.name}` : ''}
      </button>
      {open && (
        <div className="share-popover theme-picker-grid">
          {themes.map((t) => (
            <button
              key={t.id}
              className={`theme-picker-option ${themeId === t.id ? 'is-active' : ''}`}
              onClick={() => {
                setThemeId(t.id);
                setOpen(false);
              }}
            >
              <span className="theme-picker-name">{t.name}</span>
              <span className="theme-picker-description">{t.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
