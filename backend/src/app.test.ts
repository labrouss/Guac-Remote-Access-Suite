import { describe, it, expect, vi } from 'vitest';
import 'express-async-errors';
import express from 'express';
import request from 'supertest';
import { globalErrorHandler, createApp } from './app';

describe('globalErrorHandler', () => {
  it('turns a Postgres unique-constraint violation (23505) into a 409, not a 500', () => {
    const err = { code: '23505', message: 'duplicate key value violates unique constraint' };
    const req = { path: '/api/setup/admin', method: 'POST' } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;

    globalErrorHandler(err, req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'already_exists' });
  });

  it('turns any other error into a generic 500, not a crash', () => {
    const err = new Error('something else entirely');
    const req = { path: '/api/whatever', method: 'GET' } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;

    globalErrorHandler(err, req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'internal_error' });
  });
});

/**
 * The part globalErrorHandler's own unit tests above can't prove on their
 * own: that a thrown/rejected error inside a real `async` Express 4 route
 * handler actually *reaches* this middleware at all, rather than becoming
 * an uncaught exception that crashes the process — which is exactly the
 * real bug this whole fix responds to (see app.ts's import comment).
 * Express 4 does not do this automatically; only `express-async-errors`
 * patching the Router prototype (imported at the top of this file, same
 * as app.ts) makes it happen. This builds a minimal standalone app with
 * the identical pattern (async route that throws + this same error
 * handler registered last) and drives a real HTTP request through it with
 * supertest — if `express-async-errors` weren't imported, or weren't
 * imported before the router is used, this test would hang or crash
 * rather than cleanly getting a 409 back.
 */
describe('express-async-errors integration (proves the crash is actually prevented)', () => {
  it('an async route that throws a 23505-coded error results in a clean 409 response, not a crashed request', async () => {
    const app = express();
    app.get('/throws', async () => {
      const err: any = new Error('duplicate key value violates unique constraint "users_username_key"');
      err.code = '23505';
      throw err;
    });
    app.use(globalErrorHandler);

    const res = await request(app).get('/throws');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'already_exists' });
  });

  it('an async route that rejects with an ordinary error results in a clean 500, not a crashed request', async () => {
    const app = express();
    app.get('/rejects', async () => {
      throw new Error('some unexpected failure');
    });
    app.use(globalErrorHandler);

    const res = await request(app).get('/rejects');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
  });
});

describe('CORS exposed headers', () => {
  // Real bug found live: bookmark HTML export used window.open() to
  // trigger the download, which is a plain navigation and can't carry
  // this app's bearer token (stored in sessionStorage, not a cookie) —
  // every export request failed with missing_token regardless of login
  // state. Fixed on the frontend by switching to an authenticated
  // fetch() + blob download, which reads the server's own sanitized
  // filename back from the Content-Disposition response header. That
  // header isn't exposed to cross-origin fetch() callers by default
  // under CORS — createApp()'s cors() call needed exposedHeaders set
  // explicitly, or the frontend fix would have silently gotten a null
  // filename in any genuinely cross-origin deployment (same-origin
  // setups, like nginx fronting both frontend and backend in
  // production, would have masked this). Verified directly against a
  // real running instance of createApp(), not just read from config.
  it('exposes Content-Disposition to cross-origin fetch() callers', async () => {
    const app = createApp();
    app.get('/test-download', (_req, res) => {
      res.setHeader('Content-Disposition', 'attachment; filename="test.html"');
      res.send('ok');
    });

    const res = await request(app).get('/test-download').set('Origin', 'https://example.com');

    expect(res.headers['access-control-expose-headers']).toContain('Content-Disposition');
  });
});
