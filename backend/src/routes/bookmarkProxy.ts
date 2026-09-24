import { Router, Request, Response, NextFunction } from 'express';
import { Server, IncomingMessage } from 'http';
import { Socket } from 'net';
import httpProxy from 'http-proxy';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import rateLimit from 'express-rate-limit';
import { db } from '../db';
import { hasBookmarkAccess } from '../services/permissions';
import { verifyProxySession, verifyProxySessionToken, extractProxyCookieFromRawHeader } from '../services/bookmarkProxy';

export const bookmarkProxyRouter = Router();

// Generous relative to normal use (a page load can fire dozens of asset
// requests) but still bounds an abusive client hammering an internal host
// through the proxy. Keyed by IP since proxy requests authenticate via
// cookie, not a per-request token that would make a per-user key easy.
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Verifies the path-scoped cookie (see services/bookmarkProxy.ts), re-checks
 * the bookmark is still in 'proxied' mode and the user still has 'view' on
 * its list (defense in depth — permissions can change after the cookie was
 * issued), then resolves the actual target origin/path onto req so the
 * http-proxy-middleware instance below can route to it.
 */
async function resolveProxyTarget(req: Request, res: Response, next: NextFunction) {
  const { bookmarkId } = req.params;
  const userId = verifyProxySession(req, bookmarkId);
  if (!userId) return res.status(401).send('Proxy session expired or missing. Reopen this bookmark from the app.');

  const bookmark = await db.oneOrNone(
    `SELECT list_id, url, access_mode FROM bookmarks WHERE id = $1`,
    [bookmarkId]
  );
  if (!bookmark || bookmark.access_mode !== 'proxied') return res.status(404).end();

  const allowed = await hasBookmarkAccess(userId, bookmarkId, 'view');
  if (!allowed) return res.status(403).end();

  const target = new URL(bookmark.url);
  (req as any).proxyTargetOrigin = target.origin;
  (req as any).proxyTargetBasePath = target.pathname.replace(/\/$/, ''); // strip trailing slash, pathRewrite adds it back
  next();
}

// NOTE ON LIMITATIONS: this rewrites the request path, the Location
// header on redirects, and — in response to a real,
// confirmed report of exactly this failure — literal occurrences of the
// target's own origin found directly in text-based response bodies
// (HTML/CSS/JS/plain text), covering a target that hardcodes its own
// absolute address (e.g. `https://internal-host/app.js`) as well as the
// path-relative case this already handled. Still not a universal
// solution for every app: a target whose JavaScript *constructs* its own
// URLs at runtime (e.g. `location.host + '/api/...'`, or reading its own
// origin from `window.location` rather than a literal string in the
// source) computes something this proxy has no text to rewrite in the
// first place, and would still need to be dealt with case by case, not
// something a response-body find-and-replace can ever fully solve in
// general. Treat this the same way you'd treat any lightweight reverse
// proxy: works well for straightforward internal web UIs, not a
// guarantee for every app.
//
// WebSocket upgrades are handled separately, NOT by this HTTP middleware
// (ws: false below) — see attachBookmarkProxyWebsockets. Express's request
// pipeline never sees a WS handshake; it's a raw 'upgrade' event on the
// underlying http.Server, so it needs its own listener and its own
// bookmark/permission lookup rather than reusing this middleware chain.
bookmarkProxyRouter.use(
  '/:bookmarkId',
  proxyLimiter,
  resolveProxyTarget,
  (req, res, next) => {
    const proxy = createProxyMiddleware({
      target: (req as any).proxyTargetOrigin,
      changeOrigin: true,
      ws: false,
      secure: false,
      // Required for responseInterceptor below to be able to do
      // anything at all — without this, http-proxy-middleware calls
      // res.end() itself as soon as the upstream response finishes,
      // before any interceptor would ever get a chance to run.
      selfHandleResponse: true,
      pathRewrite: (path: string) => `${(req as any).proxyTargetBasePath}${path}`,
      onProxyRes: responseInterceptor(async (buffer: Buffer, proxyRes: import('http').IncomingMessage, _req2: import('http').IncomingMessage, res2: import('http').ServerResponse) => {
        // Keep redirects inside the proxy path prefix rather than sending
        // the browser straight at the unreachable internal host. Uses
        // res2.setHeader (not a proxyRes.headers mutation) deliberately —
        // responseInterceptor's own internal copyHeaders(proxyRes, res)
        // already ran and copied proxyRes's original headers onto res2
        // by the time this callback runs, so overriding res2 directly
        // here is what actually takes effect; mutating proxyRes.headers
        // at this point would be too late to matter.
        // Deliberately reads proxyTargetOrigin/params off the outer,
        // already-Express req in closure scope rather than the req
        // parameter responseInterceptor itself passes in — that one is
        // typed (correctly) as the raw http.IncomingMessage node itself
        // sees, not the Express-enhanced request resolveProxyTarget
        // actually attached proxyTargetOrigin to.
        const target = (req as any).proxyTargetOrigin as string;
        const location = proxyRes.headers.location;
        if (location) {
          try {
            if (location.startsWith(target)) {
              const bookmarkId = req.params.bookmarkId;
              res2.setHeader('location', location.replace(target, `/proxy/${bookmarkId}`));
            }
          } catch {
            // Leave the header as-is if rewriting fails — better a broken
            // redirect than a crashed proxy.
          }
        }

        // Real bug found live, reported directly as "an empty page" —
        // the proxy connection itself was working correctly (an earlier
        // fix), but the target's own Content-Security-Policy header was
        // being forwarded to the browser completely unmodified. A modern
        // management UI's CSP is written for its own real origin and URL
        // structure — under this proxy's rewritten /proxy/:bookmarkId/
        // path, that policy no longer matches reality at all, and a
        // strict one (script-src 'self', for instance) silently blocks
        // exactly the scripts that would render the page's actual
        // content, leaving only whatever bare HTML shell loaded first.
        // That's precisely what "connects fine, shows nothing" looks
        // like for a JS-heavy single-page app.
        // Stripped rather than rewritten — correctly rewriting an
        // arbitrary target's CSP for a moved path is a much harder
        // problem (many directives, each with their own syntax, some
        // referencing the origin in ways a simple path swap can't fix)
        // than the security value it would preserve here actually
        // justifies: the browser's own same-origin policy and this
        // proxy's own auth (the path-scoped session cookie) already
        // gate access to this content, so a target-authored CSP intended
        // for its own unrelated origin isn't doing much useful work in
        // this context anyway.
        res2.removeHeader('content-security-policy');
        res2.removeHeader('content-security-policy-report-only');

        // Real bug found live, matching a well-known reverse-proxy
        // failure class precisely — reported as a redirect loop landing
        // specifically on a /login/auth-style path, exactly what this
        // causes. Per RFC 6265, a Set-Cookie response with no explicit
        // Path attribute defaults the cookie's path to the *directory of
        // the request that set it*, not the app's own root. A login
        // response at .../login/auth setting a session cookie with no
        // Path at all would default to something like
        // /proxy/<bookmarkId>/login/ — meaning the browser would only
        // ever send that cookie back for further requests under that
        // same login/ subpath, never for the rest of the app under
        // /proxy/<bookmarkId>/ generally. The target then never sees its
        // own session cookie on the very next request, concludes the
        // user still isn't authenticated, and redirects back to login
        // again — forever. Rewrites every cookie's Path to the whole
        // proxy prefix for this bookmark unconditionally, whether the
        // target specified one of its own or not — a target-authored
        // Path is meaningless here regardless, since it was written for
        // the target's own real root, not this proxy's rewritten one.
        const setCookie = res2.getHeader('set-cookie');
        if (setCookie) {
          const bookmarkId = req.params.bookmarkId;
          const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
          // Matches only a genuine "; Path=..." attribute (semicolon
          // required) — a bare "path=" search could otherwise
          // accidentally match and corrupt a cookie whose own name or
          // value happens to contain that substring.
          const rewritten = cookies.map((c) =>
            /;\s*path=/i.test(c)
              ? c.replace(/;\s*path=[^;]*/i, `; Path=/proxy/${bookmarkId}`)
              : `${c}; Path=/proxy/${bookmarkId}`
          );
          res2.setHeader('set-cookie', rewritten);
        }

        // Real bug found live, confirmed directly — not guessed —
        // against the actual backend logs: reported as "an unverified
        // certificate" error blocking the page, with the address bar
        // showing the internal host directly instead of /proxy/... at
        // all. Nothing in the backend's own logs (including this same
        // file's round-37 onError handler, added specifically to
        // surface exactly this kind of failure) ever recorded a
        // connection attempt for it — meaning the browser wasn't going
        // through this proxy for that request in the first place. Real
        // cause, confirmed by that absence: some absolute URL
        // (`https://<internal-host>/...`) baked directly into the
        // target's own HTML, CSS, or JavaScript, which sends the
        // browser straight at the unreachable internal host on its own,
        // entirely outside this proxy — where the browser then enforces
        // its own, real certificate validation with no way for this
        // proxy's secure: false to have ever applied, since the request
        // never reached it. This was already a known, explicitly
        // documented limitation of the path/redirect-only rewriting
        // above (see resolveProxyTarget's own comment) — this is what
        // actually closes that gap, not just documents around it:
        // rewrites every occurrence of the target's own origin found
        // directly in text-based response bodies to the proxy's own
        // path instead, so a reference the target wrote as
        // `https://10.1.11.35/app.js` becomes `/proxy/<bookmarkId>/app.js`
        // — a request the browser will actually send back through this
        // proxy, the same as everything else on the page already does.
        const contentType = (proxyRes.headers['content-type'] as string) || '';
        if (!/text\/html|text\/css|javascript|text\/plain/i.test(contentType)) {
          return buffer; // binary or unrecognized content — passed through unmodified, never treated as text
        }
        const bookmarkId = req.params.bookmarkId;
        const proxyPath = `/proxy/${bookmarkId}`;
        let text = buffer.toString('utf8');
        text = text.split(target).join(proxyPath); // absolute, e.g. https://10.1.11.35:8006/...
        const targetNoScheme = target.replace(/^https?:/, ''); // protocol-relative, e.g. //10.1.11.35:8006/...
        text = text.split(targetNoScheme).join(proxyPath);
        return text;
      }),
      onError: (err: Error, req3: Request, res3: Response) => {
        // Logs the real, specific underlying error server-side (e.g.
        // ECONNREFUSED, ENOTFOUND, a TLS handshake failure, a timeout) —
        // previously nothing was ever logged here at all, leaving no way
        // to tell these apart from the generic client-facing message
        // alone. Message itself deliberately stays generic to the
        // browser regardless — this route is already behind the
        // path-scoped proxy-session cookie, so the caller is a verified,
        // authorized user, but the specific failure reason (an internal
        // hostname, a port, a certificate detail) still isn't something
        // to hand back in a raw HTTP response body by default.
        console.error(`[bookmark-proxy] ${req3.params.bookmarkId} -> ${(req3 as any).proxyTargetOrigin}:`, err.message);
        if (!res3.headersSent) {
          res3.status(502).send('Could not reach the proxied host. Check the server logs for the specific connection error.');
        }
      }
    } as any); // http-proxy-middleware's types lag its own documented option shape in places
    proxy(req, res, next);
  }
);

/**
 * Handles WebSocket upgrade requests for proxied bookmarks. This attaches
 * directly to the http.Server's 'upgrade' event rather than going through
 * Express, since that's where Node dispatches WS handshakes — the request
 * never reaches Express middleware at all. guacamole-lite attaches its own
 * 'upgrade' listener on the same server for the Guacamole tunnel itself;
 * both listeners fire for every upgrade request, so this one explicitly
 * ignores anything not under /proxy/ rather than assuming it's the only
 * listener registered.
 */
/**
 * Minimal in-memory sliding-window limiter for WS upgrade *attempts* specifically
 * (not the proxyLimiter above, which is Express middleware and never runs for
 * upgrade requests — they bypass Express's request pipeline entirely, landing
 * directly on the http.Server's 'upgrade' event instead). Keyed by remote IP
 * since, same as the HTTP proxy path, there's no per-request auth token to key
 * on before the cookie itself is verified.
 */
const wsUpgradeAttempts = new Map<string, number[]>();
const WS_UPGRADE_WINDOW_MS = 60 * 1000;
const WS_UPGRADE_MAX_PER_WINDOW = 20;

function isWsUpgradeRateLimited(ip: string): boolean {
  const now = Date.now();
  const attempts = (wsUpgradeAttempts.get(ip) ?? []).filter((t) => now - t < WS_UPGRADE_WINDOW_MS);
  attempts.push(now);
  wsUpgradeAttempts.set(ip, attempts);
  return attempts.length > WS_UPGRADE_MAX_PER_WINDOW;
}

// Without this, an IP that connects once and never again stays in the map
// forever — harmless per-entry, but unbounded over a long-running process
// with many distinct client IPs. Prune anything with no attempts in the
// current window every few minutes.
setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of wsUpgradeAttempts) {
    if (attempts.every((t) => now - t >= WS_UPGRADE_WINDOW_MS)) wsUpgradeAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

export function attachBookmarkProxyWebsockets(server: Server) {
  server.on('upgrade', async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!req.url?.startsWith('/proxy/')) return; // not ours — let guacamole-lite's own listener handle it

    const clientIp = req.socket.remoteAddress ?? 'unknown';
    if (isWsUpgradeRateLimited(clientIp)) return socket.destroy();

    const segments = req.url.split('/'); // ['', 'proxy', ':bookmarkId', ...rest]
    const bookmarkId = segments[2];
    if (!bookmarkId) return socket.destroy();

    const rawToken = extractProxyCookieFromRawHeader(req.headers.cookie);
    const userId = verifyProxySessionToken(rawToken, bookmarkId);
    if (!userId) return socket.destroy();

    const bookmark = await db.oneOrNone(
      `SELECT list_id, url, access_mode, enable_websocket FROM bookmarks WHERE id = $1`,
      [bookmarkId]
    );
    if (!bookmark || bookmark.access_mode !== 'proxied' || !bookmark.enable_websocket) {
      return socket.destroy();
    }

    const allowed = await hasBookmarkAccess(userId, bookmarkId, 'view');
    if (!allowed) return socket.destroy();

    const target = new URL(bookmark.url);
    const basePath = target.pathname.replace(/\/$/, '');
    const subPath = '/' + segments.slice(3).join('/');

    // Rewrite the path the same way the HTTP pathRewrite above does, so a
    // target whose WebSocket endpoint lives under its own base path
    // (bookmark.url = http://host:8080/app) resolves correctly.
    req.url = `${basePath}${subPath}`;

    const proxy = httpProxy.createProxyServer({});
    // Same real bug, same fix, as the HTTP proxy path just above this
    // one in the file — see createProxyMiddleware's own secure: false
    // comment for the full reasoning (a self-signed certificate on the
    // target internal infrastructure rejecting the TLS handshake
    // outright, indistinguishable from any other connection failure
    // without logging the actual error). Also logs the real underlying
    // error now, same as the HTTP path — previously this silently
    // destroyed the socket with zero indication of why.
    proxy.on('error', (err) => {
      console.error(`[bookmark-proxy-ws] ${bookmarkId} -> ${target.origin}:`, err.message);
      socket.destroy();
    });
    proxy.ws(req, socket, head, { target: target.origin, changeOrigin: true, secure: false });
  });
}
