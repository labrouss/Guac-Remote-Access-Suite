// MUST be the very first import — express-async-errors patches Express's
// Router prototype at import time, and every router (setupRouter,
// adminRouter, etc.) is created via `import`s below, which run before any
// code in this file's own body executes. This is the fix for a real,
// serious bug found via a live deployment: without it, an unhandled
// rejection inside any `async` Express 4 route handler (this app's routes
// are virtually all `async`) doesn't reach Express's error-handling
// middleware at all — it becomes a genuinely uncaught exception that
// crashes the entire Node process, taking down every other in-flight
// request along with it. Confirmed directly: a duplicate-username INSERT
// (Postgres error code 23505, a completely ordinary, expected-to-happen
// error condition) crashed the whole backend outright, and the very next
// request from a different part of the same setup flow got a 502 because
// there was, briefly, no server at all to answer it.
import 'express-async-errors';

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';

import { requireSetupComplete } from './middleware/requireSetup';
import { requireAuth } from './middleware/requireAuth';
import { setupRouter } from './routes/setup';
import { authRouter } from './routes/auth';
import { connectionsRouter } from './routes/connections';
import { credentialsRouter } from './routes/credentials';
import { bookmarksRouter } from './routes/bookmarks';
import { bookmarkProxyRouter } from './routes/bookmarkProxy';
import { sessionsRouter } from './routes/sessions';
import { tunnelTokenRouter } from './routes/tunnelToken';
import { adminRouter } from './routes/admin';
import { auditLogRouter } from './routes/auditLog';
import { demosRouter } from './routes/demos';
import { meRouter } from './routes/me';
import { usersRouter } from './routes/users';
import { versionRouter } from './routes/version';
import { localesRouter } from './routes/locales';
import { logger } from './services/logger';

/**
 * Builds the Express app with no side effects (no port binding, no
 * WebSocket upgrade wiring) — those live in server.ts, which imports this.
 * Split out specifically so integration tests can mount the real app via
 * `supertest(createApp())` against a real ephemeral Postgres, without
 * needing an actual listening port or guacd/WebSocket plumbing that has
 * nothing to do with the HTTP routes being tested. See
 * backend/tests-integration/ and docs/TESTING_PLAN.md's Layer 2 section.
 */
/**
 * Registered last, after every route — this is what actually turns a
 * thrown/rejected error into a real HTTP response instead of a crashed
 * process. Extracted as a named, exported function specifically so it's
 * directly unit-testable (see app.test.ts) rather than only verifiable by
 * inspecting createApp()'s full route wiring.
 */
export function globalErrorHandler(err: any, req: express.Request, res: express.Response, _next: express.NextFunction) {
  // Postgres unique-constraint violation (e.g. a duplicate username from a
  // double-submitted form, a retried request, etc.) is a completely
  // ordinary, expected-to-happen condition — worth a specific, useful
  // response rather than a generic 500. Anything else still becomes a
  // 500, but a handled, logged one that answers the request instead of
  // taking the whole server down with it.
  if (err?.code === '23505') {
    return res.status(409).json({ error: 'already_exists' });
  }

  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error in request handler');
  res.status(500).json({ error: 'internal_error' });
}

export function createApp() {
  const app = express();
  // nginx.conf sets X-Real-IP; trusting it here is what makes req.ip
  // reflect the actual client rather than the reverse proxy's own address
  // — needed for source_ip to be meaningful in audit_log entries (see
  // services/auditLog.ts).
  //
  // `1`, not `true` — confirmed as a real bug by a live deployment:
  // `true` unconditionally trusts the *entire* X-Forwarded-For chain,
  // including values a client could set themselves, which is exactly what
  // express-rate-limit's own startup validation flags
  // (ERR_ERL_PERMISSIVE_TRUST_PROXY) as a way to trivially bypass
  // IP-based rate limiting — a malicious client could just set their own
  // X-Forwarded-For header to spoof a different IP on every request. `1`
  // instead trusts exactly one hop upstream, matching this app's actual
  // topology (browser -> nginx -> backend, exactly one reverse proxy in
  // front) — nginx's own X-Real-IP is trusted, nothing a client sends
  // directly is.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use(cors({
    // Real gap found live: default cors() exposes none of the CORS
    // "safelisted" response headers beyond the handful the spec grants
    // automatically (Content-Type, Cache-Control, etc.) — Content-Disposition
    // isn't one of them. That's harmless for same-origin requests (nginx
    // fronting both frontend and backend in production), but this app
    // also supports genuinely cross-origin setups (cors() wouldn't be
    // configured at all otherwise, e.g. local dev with Vite's dev server
    // on a different port than the backend) — and in that case, any
    // fetch()-based file download reading its filename back from
    // Content-Disposition would have silently gotten `null` instead,
    // regardless of a valid, present Authorization header. Discovered
    // while fixing the bookmark HTML export, which reads this header to
    // recover the server's own sanitized filename.
    //
    // X-Refreshed-Session-Token (requireAuth.ts's own sliding-window
    // refresh) needs the exact same treatment for the exact same reason
    // — added here rather than risking the identical silent-null bug a
    // second time in a genuinely cross-origin dev setup.
    exposedHeaders: ['Content-Disposition', 'X-Refreshed-Session-Token']
  }));

  // General ceiling across the whole authenticated API surface, on top of
  // the tighter per-route limiters already on login/TOTP/bookmark-proxy —
  // those exist because they're reachable pre-auth or hit an external
  // network, this exists so no single authenticated user (or a leaked/
  // compromised token) can hammer admin/demo/connection routes without any
  // limit at all. Generous by design: 300 requests/minute per IP is far
  // above normal interactive use, but still a real ceiling rather than none.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'too_many_requests', message: 'Too many requests. Slow down and try again shortly.' }
    })
  );

  // Used only by the first-time setup wizard (routes/setup.ts) to carry
  // setupUserId/pendingTotpSecret across its handful of sequential steps.
  //
  // `secure` is derived from PUBLIC_URL's protocol, not hardcoded true —
  // confirmed as a real bug via a live deployment: this app's own default
  // is plain HTTP (the frontend serves plain HTTP; a TLS-terminating
  // proxy is documented as something the operator adds in front, not
  // assumed to already exist — see README.md's TLS section), and a
  // `secure: true` cookie is never sent by the browser over a non-HTTPS
  // connection at all. With it hardcoded true, the session cookie
  // carrying the CSRF token never actually persisted across requests on
  // any HTTP deployment — every request got a brand-new, empty session,
  // so the CSRF token issued on one request could never match on the
  // next, and POST /api/setup/admin failed with 403 invalid_csrf_token
  // even with completely valid input. Once PUBLIC_URL is genuinely
  // https://, this correctly switches back to requiring secure cookies.
  const isPublicUrlHttps = (process.env.PUBLIC_URL ?? '').startsWith('https://');
  app.use(
    session({
      secret: process.env.SESSION_SECRET!,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: isPublicUrlHttps, sameSite: 'lax', maxAge: 30 * 60 * 1000 }
    })
  );
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/api/health' }
    })
  );

  app.use('/api/setup', requireSetupComplete, setupRouter);
  app.use('/api/version', versionRouter);
  app.use('/api/locales', localesRouter);
  app.use('/api/auth', authRouter);

  app.use('/api', requireSetupComplete, requireAuth);
  app.use('/api/connections', connectionsRouter);
  app.use('/api/credentials', credentialsRouter);
  app.use('/api/bookmarks', bookmarksRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/tunnel-token', tunnelTokenRouter);
  app.use('/api/admin/audit-log', auditLogRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/demos', demosRouter);
  app.use('/api/me', meRouter);
  app.use('/api/users', usersRouter);

  // Note: this only covers the HTTP proxy path — WebSocket upgrade proxying
  // (attachBookmarkProxyWebsockets) is a raw 'upgrade' listener on the
  // http.Server itself, wired in server.ts, and out of scope here.
  app.use('/proxy', requireSetupComplete, bookmarkProxyRouter);

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // Must be registered LAST — Express only routes to error-handling
  // middleware (4-argument signature) when something earlier calls
  // next(err) or throws/rejects inside a route wrapped by
  // express-async-errors (see the import at the top of this file). Without
  // this catch-all, an error reaching this point would still crash the
  // process the same way the bug described above did — this is the other
  // half of that fix, not just the async-forwarding part.
  app.use(globalErrorHandler);

  return app;
}
