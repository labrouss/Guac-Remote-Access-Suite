import { Request, Response, NextFunction } from 'express';
import { db } from '../db';

/**
 * Gates every request behind first-time setup completion.
 * - Before setup: only /api/setup/* is reachable.
 * - After setup: /api/setup/* becomes permanently unreachable (410) —
 *   EXCEPT /api/setup/status itself, which stays reachable forever. See
 *   the comment further down for why.
 */
export async function requireSetupComplete(req: Request, res: Response, next: NextFunction) {
  const config = await db.one(`SELECT setup_completed FROM system_config WHERE id = true`);

  // req.originalUrl, NOT req.path — this middleware is reused across three
  // different mount points (app.ts: /api/setup, /api, /proxy), and
  // req.path is relative to whichever mount point actually invoked it
  // (Express strips the mount prefix for anything mounted via
  // app.use(prefix, ...)). req.originalUrl always reflects the real, full
  // request path regardless of mounting depth. Using req.path here was a
  // real bug, found via a live deployment: /api/setup/status itself — the
  // one route whose entire job is reporting setup status — was being
  // evaluated with req.path === '/status' (prefix already stripped by the
  // /api/setup mount), so it was incorrectly caught by the "block unless
  // setup is complete" branch, returning 423 exactly when the frontend's
  // very first bootstrap check needed a real answer.
  const path = req.originalUrl.split('?')[0];

  // /api/setup/status is deliberately exempt from the 410-once-complete
  // rule below, unlike every other /api/setup/* route. Its entire
  // purpose is being callable in BOTH states — before setup, so the
  // frontend knows to show the wizard, and after, so it knows to show
  // login instead. Found live, and it's a serious one: once setup
  // genuinely completed, this endpoint started 410ing permanently,
  // which — combined with App.tsx correctly treating any non-OK
  // response as "can't reach the server" (a separate, earlier fix) —
  // meant literally every user, forever, would see that error screen
  // instead of the login page. Every other /api/setup/* route (admin
  // creation, TOTP enrollment, etc.) still correctly 410s once
  // complete — you genuinely can't re-run the wizard.
  if (config.setup_completed && path === '/api/setup/status') {
    return next();
  }

  if (!config.setup_completed && !path.startsWith('/api/setup')) {
    return res.status(423).json({ error: 'setup_required', redirect: '/setup' });
  }

  if (config.setup_completed && path.startsWith('/api/setup')) {
    return res.status(410).json({ error: 'setup_already_completed' });
  }

  next();
}
