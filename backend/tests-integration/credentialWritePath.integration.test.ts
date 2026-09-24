import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { authenticator } from 'otplib';
import { startTestDatabase, stopTestDatabase, createTestApp, installMockVaultFetch } from './harness';

// DRAFTED, UNVERIFIED — see ./harness.ts's header comment.
//
// This file specifically verifies the actual row shape landing in
// connection_credentials by querying real Postgres directly (via the same
// `db` singleton the app uses) — something Layer 1's mocked-db tests
// (credentials.test.ts) can assert about the *intended* SQL parameters,
// but can't prove about what a real INSERT ... ON CONFLICT actually
// persists.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('node-fetch', () => ({ default: fetchMock }));

let app: Express;
let adminToken: string;
let listId: string;

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
  const totpSecret = /secret=([A-Z0-9]+)/.exec(enrollRes.body.otpauthUrl)![1];
  await agent.post('/api/setup/totp/verify').send({ code: authenticator.generate(totpSecret) });
  await agent.post('/api/setup/complete');

  adminToken = await loginAndGetToken('admin', 'correct horse battery staple', totpSecret);

  const listRes = await request(app)
    .post('/api/admin/lists')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Credential Test List', description: '' });
  listId = listRes.body.id;
}, 60_000);

afterAll(async () => {
  await stopTestDatabase();
});

describe('credential write path', () => {
  it('an individual-mode write lands a row scoped to the writer, not NULL', async () => {
    const connRes = await request(app)
      .post(`/api/admin/lists/${listId}/connections`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Individual Target', protocol: 'ssh', hostname: '10.0.0.30', port: 22, credentialMode: 'individual' });
    const connectionId = connRes.body.id;

    const writeRes = await request(app)
      .put(`/api/credentials/${connectionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'svc-account', secret: 'hunter2' });
    expect(writeRes.status).toBe(200);

    const { db } = await import('../src/db');
    const row = await db.oneOrNone(
      `SELECT user_id, username_encrypted, secret_encrypted FROM connection_credentials WHERE connection_id = $1`,
      [connectionId]
    );
    expect(row).not.toBeNull();
    expect(row.user_id).not.toBeNull(); // scoped to the admin who wrote it, not shared
    // The mocked Vault "encrypts" as `vault:v1:${plaintext}` — confirms the
    // app actually calls through encryptCredential rather than storing
    // plaintext directly.
    expect(row.username_encrypted).toBe('vault:v1:svc-account');

    const statusRes = await request(app)
      .get(`/api/credentials/${connectionId}/status`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(statusRes.body).toEqual({ configured: true, mode: 'individual' });
  });

  it('a shared-mode write lands a row with a NULL user_id', async () => {
    const connRes = await request(app)
      .post(`/api/admin/lists/${listId}/connections`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Shared Target', protocol: 'ssh', hostname: '10.0.0.31', port: 22, credentialMode: 'shared' });
    const connectionId = connRes.body.id;

    await request(app)
      .put(`/api/credentials/${connectionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'shared-svc', secret: 'hunter3' });

    const { db } = await import('../src/db');
    const row = await db.oneOrNone(
      `SELECT user_id FROM connection_credentials WHERE connection_id = $1`,
      [connectionId]
    );
    expect(row).not.toBeNull();
    expect(row.user_id).toBeNull();
  });

  it('a user with only connect (not admin) cannot write a shared-mode credential', async () => {
    const connRes = await request(app)
      .post(`/api/admin/lists/${listId}/connections`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Shared Target 2', protocol: 'ssh', hostname: '10.0.0.32', port: 22, credentialMode: 'shared' });
    const connectionId = connRes.body.id;

    const createRes = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'connect-only-user', password: 'a fourth long password' });
    const limitedUserToken = await loginAndGetToken('connect-only-user', 'a fourth long password');

    await request(app)
      .post(`/api/admin/lists/${listId}/permissions/user`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: createRes.body.id, permission: 'connect' });

    const writeRes = await request(app)
      .put(`/api/credentials/${connectionId}`)
      .set('Authorization', `Bearer ${limitedUserToken}`)
      .send({ username: 'attempted-write', secret: 'hunter4' });
    expect(writeRes.status).toBe(403);
  });

  it('that same connect-only user CAN write their own individual-mode credential', async () => {
    const connRes = await request(app)
      .post(`/api/admin/lists/${listId}/connections`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Individual Target 2', protocol: 'ssh', hostname: '10.0.0.33', port: 22, credentialMode: 'individual' });
    const connectionId = connRes.body.id;

    const createRes = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'self-service-user', password: 'a fifth long password' });
    const selfServiceToken = await loginAndGetToken('self-service-user', 'a fifth long password');

    await request(app)
      .post(`/api/admin/lists/${listId}/permissions/user`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: createRes.body.id, permission: 'connect' });

    const writeRes = await request(app)
      .put(`/api/credentials/${connectionId}`)
      .set('Authorization', `Bearer ${selfServiceToken}`)
      .send({ username: 'my-own-username', secret: 'my-own-secret' });
    expect(writeRes.status).toBe(200);
  });
});
