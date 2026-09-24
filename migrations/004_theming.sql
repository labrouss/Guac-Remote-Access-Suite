-- Theming: system + user-created themes, export/import as JSON tokens
CREATE TABLE themes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES users(id) ON DELETE CASCADE, -- NULL = system/built-in theme
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_system BOOLEAN NOT NULL DEFAULT false,
    tokens JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users
    ADD CONSTRAINT fk_users_active_theme
    FOREIGN KEY (active_theme_id) REFERENCES themes(id) ON DELETE SET NULL;

-- Seed the default "Signal (Dark)" system theme
INSERT INTO themes (name, description, is_system, tokens) VALUES (
    'Signal (Dark)',
    'Default dark theme drawing on SFP/port link-light semantics: dual cyan/amber accent, dense data-table friendly layout.',
    true,
    '{
      "colors": {
        "bg-void": "#0B0F14",
        "bg-panel": "#131A22",
        "bg-inset": "#0E141B",
        "border-hairline": "#1F2933",
        "fiber-cyan": "#4DD8E6",
        "signal-amber": "#F5A623",
        "alert-red": "#E5484D",
        "text-primary": "#E6EDF3",
        "text-muted": "#7C8B99"
      },
      "typography": {
        "display-font": "''IBM Plex Mono'', monospace",
        "body-font": "''IBM Plex Sans'', sans-serif",
        "base-size": "14px"
      },
      "radius": { "sm": "2px", "md": "4px" }
    }'::jsonb
);
