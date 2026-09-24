import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!;

/**
 * A session's own JWT is refreshed (sliding window) on every
 * authenticated request (see requireAuth.ts) — SESSION_IDLE_TIMEOUT_MINUTES
 * is how long someone can go with no request at all before being signed
 * out, not a fixed session length; stay actively using the app and
 * you're never logged out on idle grounds. SESSION_ABSOLUTE_MAX_HOURS is
 * a separate, hard ceiling from the moment of the original login,
 * enforced regardless of activity — this app's own previous behavior
 * (a flat, non-renewing 12h expiry) is preserved as that ceiling rather
 * than lost, not replaced by the idle timeout alone: continuous activity
 * no longer keeps a session alive forever.
 */
export const SESSION_IDLE_TIMEOUT_MINUTES = Number(process.env.SESSION_IDLE_TIMEOUT_MINUTES) || 30;
export const SESSION_ABSOLUTE_MAX_HOURS = Number(process.env.SESSION_ABSOLUTE_MAX_HOURS) || 12;

export interface SessionTokenPayload {
  sub: string;
  stage: 'authenticated';
  loginAt: number; // unix seconds — when this session's original login happened, carried through every refresh
}

/**
 * Issues a session token. `loginAt` defaults to now, for a fresh login
 * (auth.ts's own two success paths); requireAuth.ts's refresh path
 * passes the *original* session's loginAt through unchanged, so the
 * absolute-max check below still measures from the real login moment
 * across any number of sliding-window refreshes, not from whichever
 * refresh happened most recently.
 */
export function issueSessionToken(userId: string, loginAt: number = Math.floor(Date.now() / 1000)): string {
  const payload: SessionTokenPayload = { sub: userId, stage: 'authenticated', loginAt };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${SESSION_IDLE_TIMEOUT_MINUTES}m` });
}

/** True once SESSION_ABSOLUTE_MAX_HOURS has elapsed since loginAt, independent of the token's own (idle-window) expiry. */
export function hasExceededAbsoluteMax(loginAt: number): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds - loginAt > SESSION_ABSOLUTE_MAX_HOURS * 60 * 60;
}
