import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { issueSessionToken, hasExceededAbsoluteMax, SessionTokenPayload } from '../services/sessionToken';

const JWT_SECRET = process.env.JWT_SECRET!;

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * A session's idle timeout is enforced by the token's own (short) expiry
 * combined with the refresh issued here on every request that reaches
 * this far — see sessionToken.ts's own comment for the full reasoning.
 * The absolute-max check below is a second, independent limit: without
 * it, continuous activity alone would keep a session alive forever,
 * which is exactly the behavior this app's own previous flat 12h expiry
 * was providing and that this change is careful not to silently drop.
 *
 * The frontend's own fetch interceptor decides whether to actually keep
 * the refreshed token this returns (see installAuthFetchInterceptor's
 * comment for why: a session with only background polling happening,
 * and no genuine mouse/keyboard activity, should still time out on idle
 * grounds even though the poll itself is a perfectly valid, successful
 * request as far as this middleware can tell) — this middleware always
 * refreshes on every valid request regardless, since it has no way to
 * know which requests correspond to genuine user activity and which
 * don't; that distinction is made client-side, not here.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'missing_token' });

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as SessionTokenPayload;
    if (payload.stage !== 'authenticated') return res.status(401).json({ error: 'incomplete_login' });
    if (hasExceededAbsoluteMax(payload.loginAt)) {
      return res.status(401).json({ error: 'session_expired' });
    }
    req.userId = payload.sub;
    res.setHeader('X-Refreshed-Session-Token', issueSessionToken(payload.sub, payload.loginAt));
    next();
  } catch {
    res.status(401).json({ error: 'invalid_or_expired_token' });
  }
}
