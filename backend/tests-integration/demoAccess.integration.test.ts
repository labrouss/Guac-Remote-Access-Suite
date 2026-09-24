import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { authenticator } from 'otplib';
import { startTestDatabase, stopTestDatabase, createTestApp, installMockVaultFetch } from './harness';

// DRAFTED, UNVERIFIED — see ./harness.ts's header comment.
//
// One thing worth calling out for whoever runs this first: the expiry test
// below deliberately grants access with an expiresAt already in the past,
// rather than trying to fake time forward. Postgres's own now() (used in
// the actual SQL — see demos.ts / permissions.ts) is evaluated by the
// database server, not by Node's clock, so vi.useFakeTimers() would have
// no effect on it at all. Granting an already-expired timestamp is the
// only reliable way to exercise the expiry path in a real-Postgres test.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('node-fetch', () => ({ default: fetchMock }));

let app: Express;
let ownerToken: string;
let ownerConnectionId: string;
let personalListId: string;

async function loginAndGetToken(username: string, password: string, totpSecret?: string): Promise<string> {
  const loginRes = await request(app).post('/api/auth/login').send({ username, password });
  if (!loginRes.body.requiresTotp) return loginRes.body.sessionToken;
  const totpRes = await request(app)
    .post('/api/auth/login/totp')
    .send({ pendingToken: loginRes.body.pendingToken, code: authenticator.generate(totpSecret!) });
  return totpRes.body.sessionToken;
}

/** Creates a user via the admin API and returns both their id and session token. */
async function createAndLoginUser(username: string, password: string): Promise<{ id: string; token: string }> {
  const createRes = await request(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ username, password });
  const token = await loginAndGetToken(username, password);
  return { id: createRes.body.id, token };
}

beforeAll(async () => {
  await startTestDatabase();
  installMockVaultFetch(fetchMock);
  app = await createTestApp();

  const agent = request.agent(app);
  await agent.post('/api/setup/admin').send({ username: 'presales', password: 'correct horse battery staple' });
  const enrollRes = await agent.post('/api/setup/totp/enroll');
  const totpSecret = /secret=([A-Z0-9]+)/.exec(enrollRes.body.otpauthUrl)![1];
  await agent.post('/api/setup/totp/verify').send({ code: authenticator.generate(totpSecret) });
  await agent.post('/api/setup/complete');

  ownerToken = await loginAndGetToken('presales', 'correct horse battery staple', totpSecret);

  // Add a connection to the owner's own personal list — provisioned
  // automatically for every user, so no admin/list-creation step needed
  // just to have something to curate into a demo.
  const myListRes = await request(app).get('/api/connections/my-list').set('Authorization', `Bearer ${ownerToken}`);
  personalListId = myListRes.body.id;

  const connRes = await request(app)
    .post(`/api/admin/lists/${personalListId}/connections`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ name: 'Veeam Backup Server', protocol: 'rdp', hostname: '10.0.0.20', port: 3389, credentialMode: 'individual' });
  ownerConnectionId = connRes.body.id;
}, 60_000);

afterAll(async () => {
  await stopTestDatabase();
});

describe('demo access flow', () => {
  it("creates a demo, adds an item from the owner's own list, and the owner sees it in the resolved view", async () => {
    const demoRes = await request(app)
      .post('/api/demos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ slug: 'veeamdemo', title: 'Veeam Demo', description: 'Backup + restore walkthrough' });
    expect(demoRes.status).toBe(200);
    const demoId = demoRes.body.id;

    const addItemRes = await request(app)
      .post(`/api/demos/${demoId}/items`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ itemType: 'connection', itemId: ownerConnectionId, sortOrder: 0 });
    expect(addItemRes.status).toBe(200);

    const viewRes = await request(app).get(`/api/demos/${demoId}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(viewRes.status).toBe(200);
    expect(viewRes.body.isOwner).toBe(true);
    expect(viewRes.body.items).toHaveLength(1);
    expect(viewRes.body.items[0].id).toBe(ownerConnectionId);
  });

  it('a user with a valid grant sees exactly the demo items, with zero access to the parent list', async () => {
    const demoRes = await request(app)
      .post('/api/demos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ slug: 'veeamdemo-2', title: 'Veeam Demo 2', description: '' });
    const demoId = demoRes.body.id;
    await request(app)
      .post(`/api/demos/${demoId}/items`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ itemType: 'connection', itemId: ownerConnectionId, sortOrder: 0 });

    const customer = await createAndLoginUser('customer', 'a customer-facing password');

    // Before any grant: not_authorized on the demo, AND no access to the
    // underlying connection's own list either — confirming the demo really
    // is independent of list permissions, not just redundant with them.
    const beforeGrantRes = await request(app).get(`/api/demos/${demoId}`).set('Authorization', `Bearer ${customer.token}`);
    expect(beforeGrantRes.status).toBe(403);

    const listAccessRes = await request(app)
      .get(`/api/connections/lists/${personalListId}/connections`)
      .set('Authorization', `Bearer ${customer.token}`);
    expect(listAccessRes.status).toBe(403);

    // Grant demo access — the customer should now see exactly this demo's
    // one item, nothing about the owner's other connections.
    await request(app)
      .post(`/api/demos/${demoId}/access`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: customer.id });

    const afterGrantRes = await request(app).get(`/api/demos/${demoId}`).set('Authorization', `Bearer ${customer.token}`);
    expect(afterGrantRes.status).toBe(200);
    expect(afterGrantRes.body.isOwner).toBe(false);
    expect(afterGrantRes.body.items).toHaveLength(1);
  });

  it('a grant with an already-past expiresAt is rejected immediately (expiry evaluated by Postgres, not Node)', async () => {
    const demoRes = await request(app)
      .post('/api/demos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ slug: 'veeamdemo-3', title: 'Veeam Demo 3', description: '' });
    const demoId = demoRes.body.id;

    const expiredCustomer = await createAndLoginUser('expired-customer', 'another customer password');

    const pastTimestamp = new Date(Date.now() - 60_000).toISOString();
    await request(app)
      .post(`/api/demos/${demoId}/access`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: expiredCustomer.id, expiresAt: pastTimestamp });

    const viewRes = await request(app).get(`/api/demos/${demoId}`).set('Authorization', `Bearer ${expiredCustomer.token}`);
    expect(viewRes.status).toBe(403);
  });

  it('revoking access removes it immediately, same as letting it expire', async () => {
    const demoRes = await request(app)
      .post('/api/demos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ slug: 'veeamdemo-4', title: 'Veeam Demo 4', description: '' });
    const demoId = demoRes.body.id;

    const revokedUser = await createAndLoginUser('to-be-revoked', 'yet another password');
    await request(app)
      .post(`/api/demos/${demoId}/access`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: revokedUser.id });

    const beforeRevokeRes = await request(app).get(`/api/demos/${demoId}`).set('Authorization', `Bearer ${revokedUser.token}`);
    expect(beforeRevokeRes.status).toBe(200);

    await request(app)
      .delete(`/api/demos/${demoId}/access/${revokedUser.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    const afterRevokeRes = await request(app).get(`/api/demos/${demoId}`).set('Authorization', `Bearer ${revokedUser.token}`);
    expect(afterRevokeRes.status).toBe(403);
  });
});
