import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { authenticator } from 'otplib';
import { startTestDatabase, stopTestDatabase, createTestApp, installMockVaultFetch } from './harness';

// DRAFTED, UNVERIFIED — see ./harness.ts's header comment.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('node-fetch', () => ({ default: fetchMock }));

let app: Express;
let adminToken: string;
let listId: string;
let connectionId: string;

async function loginAndGetToken(username: string, password: string, totpSecret?: string): Promise<string> {
  const loginRes = await request(app).post('/api/auth/login').send({ username, password });
  if (!loginRes.body.requiresTotp) return loginRes.body.sessionToken;
  const totpRes = await request(app)
    .post('/api/auth/login/totp')
    .send({ pendingToken: loginRes.body.pendingToken, code: authenticator.generate(totpSecret!) });
  return totpRes.body.sessionToken;
}

beforeAll(async () => {
  await startTestDatabase();
  installMockVaultFetch(fetchMock);
  app = await createTestApp();

  const agent = request.agent(app);
  await agent.post('/api/setup/admin').send({ username: 'admin', password: 'correct horse battery staple' });
  const enrollRes = await agent.post('/api/setup/totp/enroll');
  const adminTotpSecret = /secret=([A-Z0-9]+)/.exec(enrollRes.body.otpauthUrl)![1];
  await agent.post('/api/setup/totp/verify').send({ code: authenticator.generate(adminTotpSecret) });
  await agent.post('/api/setup/complete');

  adminToken = await loginAndGetToken('admin', 'correct horse battery staple', adminTotpSecret);

  const listRes = await request(app)
    .post('/api/admin/lists')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Storage Arrays', description: 'Shared list for the permission-flow test' });
  listId = listRes.body.id;

  const connRes = await request(app)
    .post(`/api/admin/lists/${listId}/connections`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Array-01', protocol: 'ssh', hostname: '10.0.0.10', port: 22, credentialMode: 'individual' });
  connectionId = connRes.body.id;
}, 60_000);

afterAll(async () => {
  await stopTestDatabase();
});

describe('connection list permission flow', () => {
  it('an unrelated user with no grant at all gets 403 on both listing and connecting', async () => {
    await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'stranger', password: 'another long password here' });
    const strangerToken = await loginAndGetToken('stranger', 'another long password here');

    const listConnRes = await request(app)
      .get(`/api/connections/lists/${listId}/connections`)
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(listConnRes.status).toBe(403);

    const tunnelRes = await request(app)
      .post(`/api/tunnel-token/${connectionId}`)
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(tunnelRes.status).toBe(403);
  });

  it("a user granted only 'view' can list the connection but cannot obtain a connect token", async () => {
    const createRes = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'viewer', password: 'yet another long password' });
    const viewerUserId = createRes.body.id;
    const viewerToken = await loginAndGetToken('viewer', 'yet another long password');

    await request(app)
      .post(`/api/admin/lists/${listId}/permissions/user`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: viewerUserId, permission: 'view' });

    const listConnRes = await request(app)
      .get(`/api/connections/lists/${listId}/connections`)
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(listConnRes.status).toBe(200);
    expect(listConnRes.body.connections).toHaveLength(1);

    const tunnelRes = await request(app)
      .post(`/api/tunnel-token/${connectionId}`)
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(tunnelRes.status).toBe(403);
  });

  it("upgrading that same user to 'connect' lets them obtain a tunnel token", async () => {
    const createRes = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'connector', password: 'a third long password' });
    const connectorUserId = createRes.body.id;
    const connectorToken = await loginAndGetToken('connector', 'a third long password');

    await request(app)
      .post(`/api/admin/lists/${listId}/permissions/user`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: connectorUserId, permission: 'connect' });

    // credentialMode: 'individual' means each user needs their own
    // credential row — added here specifically because token issuance now
    // requires one to exist (see routes/tunnelToken.ts's issueNewConnectionToken;
    // this moved from guacamole-lite's callback after an empirically-found
    // race made real async authorization there unsafe — see TODO.md).
    // Without this, the tunnel-token call below would now correctly get a
    // 409 (no_credentials_configured) rather than the 200 this test verifies.
    await request(app)
      .put(`/api/credentials/${connectionId}`)
      .set('Authorization', `Bearer ${connectorToken}`)
      .send({ username: 'connector-remote-user', secret: 'connector-remote-password' });

    // The tunnel-token route requires a credential to exist for the
    // connection before a real guacd session would proceed, and — since
    // that check now also lives in this same route (see the note above) —
    // this call exercises both the authorization check and the credential
    // requirement together, rather than authorization alone as originally
    // drafted.
    const tunnelRes = await request(app)
      .post(`/api/tunnel-token/${connectionId}`)
      .set('Authorization', `Bearer ${connectorToken}`);
    expect(tunnelRes.status).toBe(200);
    expect(tunnelRes.body.token).toBeTruthy();
  });
});
