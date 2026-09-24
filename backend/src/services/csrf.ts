import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * The setup wizard is the one flow in this app authenticated by a cookie
 * (`express-session`) rather than a Bearer token — everything else uses
 * Bearer tokens in an Authorization header, which a malicious cross-site
 * page can't attach to a forged request, sidestepping classic CSRF for
 * free. The setup wizard needed its own protection.
 *
 * Double-submit token: a random value is stored server-side in the
 * session (so it's tied to that specific session, not guessable) and
 * handed to the frontend once, which must echo it back as a header on
 * every mutating request. A cross-site attacker can trick a browser into
 * sending the session cookie automatically, but has no way to read the
 * token out of the legitimate page to also attach it as a header —
 * same-origin policy prevents that read.
 */

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
  }
}

export function issueCsrfToken(req: Request): string {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

export function requireCsrfToken(req: Request, res: Response, next: NextFunction) {
  const headerToken = req.headers['x-csrf-token'];
  if (!req.session.csrfToken || headerToken !== req.session.csrfToken) {
    return res.status(403).json({ error: 'invalid_csrf_token' });
  }
  next();
}
