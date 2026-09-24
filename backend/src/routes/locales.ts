import { Router } from 'express';
import fs from 'fs';
import path from 'path';

// dist/src/routes/locales.js, __dirname is dist/src/routes — three levels
// below /app, not two. The exact same class of path-resolution mistake
// version.ts's own comment documents having actually shipped once already
// (rootDir "." preserves the src/ prefix in the compiled output) — worth
// getting right the first time here rather than repeating it.
const DEFAULT_LOCALES_DIR = path.join(__dirname, '../../../locales');

// Deliberately strict — this becomes part of a filesystem path
// (fs.readFileSync(path.join(localesDir, \`${lang}.json\`))) built directly
// from a URL segment. Restricting it to a real language/locale code shape
// (a bare "en", or "pt-BR" with a region) rules out path traversal
// (`../../etc/passwd`) and any other unexpected input entirely, rather
// than trying to sanitize it after the fact.
const VALID_LANG = /^[a-zA-Z]{2,3}(-[a-zA-Z]{2})?$/;

/**
 * Requested directly: new languages should become available by dropping a
 * file into a directory, not by registering them anywhere in code or
 * rebuilding the frontend. Both routes below read the directory fresh on
 * every request rather than caching its contents at startup — a file
 * added while the app is already running shows up immediately, including
 * in the language picker's own list, with no restart needed at all.
 *
 * Deliberately mounted before the global requireAuth middleware
 * (app.ts) — the sign-in page itself needs translations before anyone
 * is authenticated, the same reason /api/auth and /api/setup/status are
 * mounted there too. Translation strings aren't sensitive information;
 * there's nothing here worth gating behind login.
 *
 * A factory, not a fixed router instance — locales.test.ts points this at
 * a real temporary directory with real files rather than mocking `fs`,
 * the same reasoning guacTunnel.ts/credentials.ts/demos.ts already
 * extracted logic out of inline closures for (see techdetails.md
 * Section 13). The production export below is just this called with the
 * real default path.
 */
export function createLocalesRouter(localesDir: string) {
  const router = Router();

  router.get('/', (_req, res) => {
    let files: string[];
    try {
      files = fs.readdirSync(localesDir);
    } catch {
      return res.json({ languages: [] });
    }
    const languages = files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((lang) => VALID_LANG.test(lang));
    res.json({ languages });
  });

  router.get('/:lang', (req, res) => {
    if (!VALID_LANG.test(req.params.lang)) return res.status(400).json({ error: 'invalid_language_code' });

    let content: string;
    try {
      content = fs.readFileSync(path.join(localesDir, `${req.params.lang}.json`), 'utf8');
    } catch {
      return res.status(404).json({ error: 'language_not_found' });
    }

    try {
      res.json(JSON.parse(content));
    } catch {
      // A community-contributed file with a JSON syntax error shouldn't
      // take the endpoint down for everyone else's language — reported as
      // a clear 502 (this server's own dependency, the file, is what's
      // broken) rather than crashing or returning malformed JSON the
      // frontend's i18next-http-backend would fail to parse anyway, with
      // a far less specific error.
      res.status(502).json({ error: 'invalid_translation_file' });
    }
  });

  return router;
}

export const localesRouter = createLocalesRouter(DEFAULT_LOCALES_DIR);
