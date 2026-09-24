import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { authenticator } from 'otplib';
import { startTestDatabase, stopTestDatabase, createTestApp, installMockVaultFetch } from './harness';

// DRAFTED, UNVERIFIED — see ./harness.ts's header comment.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('node-fetch', () => ({ default: fetchMock }));

let app: Express;
let totpSecret: string;

beforeAll(async () => {
  await startTestDatabase();
  installMockVaultFetch(fetchMock);
  app = await createTestApp();

  // Complete the setup wizard once so there's a real admin account with
  // TOTP enrolled to log in against. Each integration test *file* gets its
  // own fresh container (see harness.ts), so this can't be shared across
  // files — only within this one.
  const agent = request.agent(app);
  await agent.post('/api/setup/admin').send({ username: 'admin', password: 'correct horse battery staple' });
  const enrollRes = await agent.post('/api/setup/totp/enroll');
  totpSecret = /secret=([A-Z0-9]+)/.exec(enrollRes.body.otpauthUrl)![1];
  await agent.post('/api/setup/totp/verify').send({ code: authenticator.generate(totpSecret) });
  await agent.post('/api/setup/complete');
}, 60_000);

afterAll(async () => {
  await stopTestDatabase();
});

describe('login flow', () => {
  it('rejects an unknown username with a generic error (no user-enumeration signal)', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'whatever12345' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('rejects the right username with the wrong password, same generic error', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('a correct password on a TOTP-enabled account returns requiresTotp + a pending token, not a session yet', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'correct horse battery staple' });

    expect(res.status).toBe(200);
    expect(res.body.requiresTotp).toBe(true);
    expect(res.body.pendingToken).toBeTruthy();
    expect(res.body.sessionToken).toBeUndefined();
  });

  it('an invalid TOTP code is rejected and does not issue a session', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'correct horse battery staple' });

    const res = await request(app)
      .post('/api/auth/login/totp')
      .send({ pendingToken: loginRes.body.pendingToken, code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.sessionToken).toBeUndefined();
  });

  it('a valid TOTP code completes login and the resulting session token authorizes an authenticated route', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'correct horse battery staple' });

    const totpRes = await request(app)
      .post('/api/auth/login/totp')
      .send({ pendingToken: loginRes.body.pendingToken, code: authenticator.generate(totpSecret) });

    expect(totpRes.status).toBe(200);
    expect(totpRes.body.sessionToken).toBeTruthy();

    // Prove the token actually works against a real requireAuth-gated route,
    // not just that the login endpoint returned something token-shaped.
    const meRes = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${totpRes.body.sessionToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.username).toBe('admin');
  });

  it('rejects a request to an authenticated route with no token at all', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  it('rate-limits the login endpoint after repeated failures from the same client', async () => {
    // The limiter is 10 attempts / 15 minutes per IP (see auth.ts). Fire 11
    // deliberately-wrong attempts and expect the last one to be throttled
    // rather than just another 401 — this specifically distinguishes
    // "wrong password" from "you've been cut off", which a mocked-db unit
    // test can't exercise since express-rate-limit's store is real
    // in-memory state tied to the actual middleware instance.
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
