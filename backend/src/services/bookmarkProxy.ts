import jwt from 'jsonwebtoken';
import { Request, Response } from 'express';

const PROXY_SESSION_SECRET = process.env.JWT_SECRET!; // reuse the app's JWT secret; separate key if you'd rather isolate blast radius

/**
 * A browser tab opened via window.open() can't carry an Authorization
 * header, so proxied bookmarks authenticate via an HttpOnly cookie instead —
 * scoped to that specific bookmark's proxy path, not the whole app, so it
 * can't be replayed against a different bookmark or the main API.
 *
 * Real bug found live: `secure: true` was previously hardcoded
 * unconditionally — correct advice for any production deployment with a
 * real TLS-terminating reverse proxy in front (as this project's own
 * docker-compose.prod.yml explicitly recommends), but a browser will
 * *never* store or send a `secure` cookie over a plain HTTP connection at
 * all, no exceptions. For a deployment genuinely running without TLS in
 * front (an internal/lab environment — exactly the kind an internal-only
 * AD domain like `contoso.com` typically means), this meant the
 * cookie was silently, permanently rejected by the browser every single
 * time — proxied bookmarks could never have worked at all, always
 * reporting the (in that context, misleadingly worded) "expired or
 * missing" error regardless of how recently it was actually issued.
 * Reported directly, with no other plausible explanation for the message
 * appearing unconditionally on every attempt.
 *
 * Fixed by deriving `secure` from the actual request's own scheme
 * (`req.secure`, which `app.set('trust proxy', 1)` in app.ts already makes
 * correctly reflect the original client connection even behind a reverse
 * proxy that terminates TLS itself) rather than a hardcoded value — this
 * keeps the protection intact for the deployment this project actually
 * recommends (HTTPS via a reverse proxy: cookie stays `secure`, exactly as
 * before) while no longer breaking the feature entirely for one running
 * genuinely without TLS. Not a security regression for the HTTPS case, and
 * no worse than the exposure that already exists for a plain-HTTP
 * deployment's *other* credential — the main Bearer token already travels
 * over the same unencrypted connection regardless of what this one cookie
 * does.
 */
export function issueProxySessionCookie(req: Request, res: Response, bookmarkId: string, userId: string) {
  const token = jwt.sign({ userId, bookmarkId }, PROXY_SESSION_SECRET, { expiresIn: '2h' });
  res.cookie(`guac_proxy_session`, token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    path: `/proxy/${bookmarkId}`,
    maxAge: 2 * 60 * 60 * 1000
  });
}

/**
 * Core token check, independent of Express's request/cookie parsing — used
 * directly by the raw 'upgrade' event handler for WebSocket proxying (see
 * routes/bookmarkProxy.ts attachBookmarkProxyWebsockets), which only ever
 * sees a bare http.IncomingMessage, not a cookie-parser-processed Request.
 */
export function verifyProxySessionToken(token: string | undefined, bookmarkId: string): string | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, PROXY_SESSION_SECRET) as { userId: string; bookmarkId: string };
    if (payload.bookmarkId !== bookmarkId) return null; // cookie for a different bookmark's path somehow reached us
    return payload.userId;
  } catch {
    return null;
  }
}

export function verifyProxySession(req: Request, bookmarkId: string): string | null {
  return verifyProxySessionToken(req.cookies?.guac_proxy_session, bookmarkId);
}

/** Pulls the proxy session cookie out of a raw upgrade request's Cookie header. */
export function extractProxyCookieFromRawHeader(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(/(?:^|;\s*)guac_proxy_session=([^;]+)/);
  return match?.[1];
}
