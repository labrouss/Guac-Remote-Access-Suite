import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { authenticator } from 'otplib';
import { startTestDatabase, stopTestDatabase, createTestApp, installMockVaultFetch } from './harness';

// DRAFTED, UNVERIFIED — see the header comment in ./harness.ts. Written
// against every route contract as actually implemented (setup.ts), but
// never executed, since no Docker daemon has been available in this
// project's environment to run the real Postgres testcontainer this needs.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('node-fetch', () => ({ default: fetchMock }));

let app: Express;

beforeAll(async () => {
  await startTestDatabase();
  installMockVaultFetch(fetchMock);
  app = await createTestApp();
}, 60_000); // container pull + start can genuinely take a while on first run

afterAll(async () => {
  await stopTestDatabase();
});

describe('setup wizard end-to-end', () => {
  it('reports setup_completed: false before anything has run', async () => {
    const res = await request(app).get('/api/setup/status');
    expect(res.status).toBe(200);
    expect(res.body.setup_completed).toBe(false);
  });

  it('walks the full wizard and locks it permanently on completion', async () => {
    const agent = request.agent(app); // preserves the express-session cookie across steps

    // Step 1: admin account
    const adminRes = await agent
      .post('/api/setup/admin')
      .send({ username: 'admin', password: 'correct horse battery staple', instanceName: 'Test Instance' });
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.userId).toBeTruthy();

    // Step 2a: TOTP enrollment — extract the real secret from the otpauth://
    // URL so we can compute a genuinely valid current code, exactly as a
    // real authenticator app would.
    const enrollRes = await agent.post('/api/setup/totp/enroll');
    expect(enrollRes.status).toBe(200);
    const secretMatch = /secret=([A-Z0-9]+)/.exec(enrollRes.body.otpauthUrl);
    expect(secretMatch).toBeTruthy();
    const rawSecret = secretMatch![1];
    const validCode = authenticator.generate(rawSecret);

    // Step 2b: verify with a WRONG code first — should be rejected without
    // committing totp_enabled.
    const wrongVerifyRes = await agent.post('/api/setup/totp/verify').send({ code: '000000' });
    expect(wrongVerifyRes.status).toBe(400);

    // Now the real code succeeds.
    const verifyRes = await agent.post('/api/setup/totp/verify').send({ code: validCode });
    expect(verifyRes.status).toBe(200);

    // Step 3: Vault check (mocked healthy via installMockVaultFetch)
    const vaultRes = await agent.post('/api/setup/vault').send({ vaultAddr: 'https://vault.invalid' });
    expect(vaultRes.status).toBe(200);

    // Step 4: theme (no real theme id needed for this test's purposes)
    await agent.post('/api/setup/theme').send({ themeId: null });

    // Final: complete
    const completeRes = await agent.post('/api/setup/complete');
    expect(completeRes.status).toBe(200);

    // Setup should now report completed...
    const statusRes = await request(app).get('/api/setup/status');
    expect(statusRes.body.setup_completed).toBe(true);

    // ...and every /api/setup/* route should now 410, per requireSetupComplete.
    const reAdminRes = await request(app)
      .post('/api/setup/admin')
      .send({ username: 'second-admin', password: 'another long password' });
    expect(reAdminRes.status).toBe(410);
  });
});
