# Translations

Every file in this directory is a language. The app discovers what's
available by reading this directory *at runtime* — nothing is baked into
the frontend build, so adding a new language never requires rebuilding or
redeploying the app.

## Adding a language

1. Copy `en.json` to `<language-code>.json` (e.g. `es.json`, `el.json`,
   `fr.json`) — use the two-letter code from
   [ISO 639-1](https://en.wikipedia.org/wiki/List_of_ISO_639_language_codes).
2. Translate the values. Leave the keys (the left-hand side) exactly as
   they are — those are what the app actually looks up, not what gets
   shown.
3. Drop the file in this directory. If you're running via Docker Compose,
   this directory is volume-mounted into the backend container — the new
   language shows up in the language picker immediately, no restart
   needed.

You don't need to translate every key. Anything missing from your file
falls back to the English text automatically (`en.json` is always the
fallback, never removed), so a partial translation is genuinely useful and
never breaks the app for anyone using it — you can start with the keys you
care about most and fill in the rest later, or leave the rest for someone
else to contribute.

## Format

One flat-ish JSON file, grouped by feature area:

```json
{
  "common": { "signIn": "Sign in", ... },
  "login": { "title": "Sign in", ... }
}
```

Keep the same nesting `en.json` uses — the app looks values up by their
full path (e.g. `login.title`), so a key moved to a different group won't
be found.

## Coverage

Every part of the app's UI pulls its text from these files, with no
known remaining exceptions — including `SetupWizard.tsx`, the one-time
first-run setup flow that was the last piece still hardcoded, and every
other corner tracked down across several rounds of methodical checking
(see `techdetails.md` for the exact key structure and how the last few
gaps were actually found). That's a complete
pass, not a permanent guarantee — new features added after this point
start out hardcoded in English like everything here once did, until
someone migrates them the same way. Contributing or updating a
translation is still worthwhile any time; a
missing key just falls back to English rather than breaking anything.
