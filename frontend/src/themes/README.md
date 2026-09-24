# Creating a theme

Every theme is a single CSS file defining the same 13 custom properties,
scoped under `[data-theme='your-theme-id']`. That's the entire contract —
nothing else in the app needs to change to add one.

## Adding a new theme

1. Create `./your-theme-id.css`. Copy `daylight.css` as a starting point —
   it's a complete, real second theme, not just a template, so every
   property in it is genuinely in use.
2. Import it once in `main.tsx`, alongside the existing theme imports.
   Every theme's CSS is bundled unconditionally so switching is instant,
   with no network request or flash of unstyled content.
3. Add `{ id: 'your-theme-id', name: '...', description: '...' }` to the
   `THEMES` array in `registry.ts`. This is what makes it selectable —
   nothing is discovered automatically from the filesystem.

That's it. The theme picker (in the setup wizard and in the header)
reads `THEMES` directly, so a new entry there is all it takes to appear
in both places.

## Initial default

Before anyone has ever explicitly picked a theme in a given browser,
`registry.ts`'s own `getSavedThemeId()` always defaults to Signal
(Dark) — requested directly, after the previous OS-`prefers-color-scheme`-based
default meant a lot of people (anyone whose OS/browser itself defaults
to light mode — Windows very often does) never actually saw "the
default theme" as the dark one this app is designed around, on first
ever visit. This is a one-time initial default only, read once
whenever nothing has been saved yet — it never overrides an explicit
choice, and adding a new theme doesn't require touching this logic at
all.

## The 13 properties

Names are historical — they describe the *default* Signal (Dark) theme's
own choices, not a requirement. `--fiber-cyan` doesn't have to be cyan in
your theme; it's just the name of the slot that plays that role. Pick
whatever color actually works for your theme's own palette.

### Backgrounds

- **`--bg-void`** — The outermost background: behind every panel, used
  on full-page views (login, setup wizard, the base `<body>`). The
  "furthest back" layer.
- **`--bg-panel`** — Cards, modals, the main panel surface — one step
  "closer" than `--bg-void`. Should read as clearly distinct from it.
- **`--bg-inset`** — Recessed surfaces: input fields, hover states,
  selected rows. Should read as "pressed in," relative to `--bg-panel`.

### Borders

- **`--border-hairline`** — The one border color used everywhere:
  panel edges, table rules, dividers. Keep it subtle — this shows up
  dozens of times throughout the UI, so anything too high-contrast will
  feel busy fast.

### Accents

- **`--fiber-cyan`** — The primary accent: links, active/selected
  states, primary buttons, success indicators (e.g. "credentials
  configured"). This is the color used most heavily after text and
  backgrounds — it needs to hold up as both a text color (readable
  against `--bg-panel`/`--bg-inset`) and a border/background color.
- **`--signal-amber`** — Secondary accent: warnings, "proxied" tags,
  attention-but-not-error states. Used sparingly — doesn't need to
  dominate the way `--fiber-cyan` does.
- **`--alert-red`** — Errors and destructive actions only. Should read
  unambiguously as "something's wrong" or "this is destructive," and
  contrast clearly with `--fiber-cyan` and `--signal-amber` — they
  sometimes appear right next to each other (e.g. a form's error text
  under a field that also has an amber warning tag nearby).

### Text

- **`--text-primary`** — Body text, headings — the default color for
  anything readable. Needs strong contrast against `--bg-panel` and
  `--bg-void` at minimum.
- **`--text-muted`** — The single most-used property in the whole
  stylesheet (labels, hints, timestamps, secondary metadata, disabled
  states). Needs to be clearly *less* prominent than `--text-primary`
  while still being comfortably readable — this is the easiest property
  to get wrong in a new theme: too close to `--text-primary` and nothing
  reads as secondary; too close to `--bg-panel` and hints/labels
  disappear.

### Typography

- **`--display-font`** — Headings, buttons, tags, anything short and
  emphasized. Signal (Dark) uses a monospace font here deliberately (the
  "network infrastructure" feel) — this is not a requirement for other
  themes.
- **`--body-font`** — Everything else: paragraphs, form inputs, table
  cells.

### Shape

- **`--radius-sm`** — Small elements: buttons, inputs, tags.
- **`--radius-md`** — Larger surfaces: panels, modals, cards.

## What's deliberately *not* themeable

Two hardcoded colors exist outside this system on purpose, not as an
oversight: the white background behind TOTP QR codes (`.totp-qr`) and
the black background behind recorded-session playback
(`.recording-player-canvas`). Both need a fixed, theme-independent value
to stay functional — a QR code needs real black squares on a real white
background to reliably scan regardless of the active theme, and a
recording's own playback shouldn't be letterboxed in a color that
competes with whatever the recording is actually showing. Note that this
does *not* apply to a live session's own display
(`.session-canvas`) — that already correctly uses `--bg-void` like
everything else, so it does follow the active theme.

## Verifying a new theme

There's no automated check that a theme defines all 13 properties — a
missing one falls back to the browser's initial value for that CSS
property (typically `unset`/transparent), which usually breaks visibly
enough to notice (invisible text, an unstyled button) but won't error or
warn anywhere. Load the app with your theme active and check at least:
the login page, a connection list with a few connections, the admin
panel's tables, and one error state (e.g. a failed form submission) —
between them, every property above gets exercised at least once.
