import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMock = vi.hoisted(() => ({ one: vi.fn(), oneOrNone: vi.fn(), any: vi.fn(), none: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const permissionsMock = vi.hoisted(() => ({ requireListPermission: vi.fn() }));
vi.mock('../services/permissions', () => permissionsMock);

const provisioningMock = vi.hoisted(() => ({ provisionPersonalList: vi.fn(), grantListPermission: vi.fn() }));
vi.mock('../services/userProvisioning', () => provisioningMock);

const auditMock = vi.hoisted(() => ({ logAuditFromRequest: vi.fn() }));
vi.mock('../services/auditLog', () => auditMock);

const adMock = vi.hoisted(() => ({ clearAdPassthroughCredential: vi.fn(), isAdEnabled: vi.fn(() => false) }));
vi.mock('../services/activeDirectory', () => adMock);

const userRemovalMock = vi.hoisted(() => ({ removeUser: vi.fn() }));
vi.mock('../services/userRemoval', () => userRemovalMock);

import { adminRouter } from './admin';

function buildApp(userId = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).userId = userId;
    next();
  });
  app.use('/api/admin', adminRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/admin/lists/:listId/connections/export', () => {
  it('without includeCredentials, only requires view permission, and never queries connection_credentials at all', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    dbMock.one.mockResolvedValue({ name: 'My List' });
    dbMock.any.mockResolvedValue([]);

    const res = await request(buildApp()).get('/api/admin/lists/list-1/connections/export');

    expect(res.status).toBe(200);
    expect(permissionsMock.requireListPermission).toHaveBeenCalledWith('user-1', 'list-1', 'view');
    expect(res.body.includes_credentials).toBe(false);
    const query = dbMock.any.mock.calls[0][0];
    expect(query).not.toMatch(/connection_credentials/);
  });

  it('with includeCredentials=true, requires admin (not just view) — the same bar credentials.ts already sets for writing a shared credential', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(false);

    const res = await request(buildApp()).get('/api/admin/lists/list-1/connections/export?includeCredentials=true');

    expect(res.status).toBe(403);
    expect(permissionsMock.requireListPermission).toHaveBeenCalledWith('user-1', 'list-1', 'admin');
  });

  it('with includeCredentials=true and sufficient permission, includes each connection\'s own credential (shared, or the exporting user\'s own individual one) and marks the envelope accordingly', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    dbMock.one.mockResolvedValue({ name: 'My List' });
    dbMock.any.mockResolvedValue([
      { name: 'Host A', credential_username_encrypted: 'vault:v1:u', credential_secret_encrypted: 'vault:v1:s' }
    ]);

    const res = await request(buildApp('user-1')).get('/api/admin/lists/list-1/connections/export?includeCredentials=true');

    expect(res.status).toBe(200);
    expect(res.body.includes_credentials).toBe(true);
    expect(res.body.connections[0].credential_secret_encrypted).toBe('vault:v1:s');
    const [query, params] = dbMock.any.mock.calls[0];
    // The real fix, verified directly against a real database before this
    // test was written: a connection's own mode decides which
    // credential row is looked up — the shared one for 'shared', or the
    // exporting user's own row specifically for 'individual' — never a
    // different user's, and never unconditionally the shared row
    // regardless of mode, which was the actual bug reported live.
    expect(query).toMatch(/LEFT JOIN LATERAL/);
    expect(query).toMatch(/CASE WHEN c\.credential_mode = 'individual' THEN \$2::uuid ELSE NULL END/);
    expect(params).toEqual(['list-1', 'user-1']);
    expect(auditMock.logAuditFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      'connections_exported_json_with_credentials',
      { listId: 'list-1' }
    );
  });
});

describe('POST /api/admin/lists/:listId/connections/import', () => {
  const baseConnection = { name: 'Host A', protocol: 'ssh', hostname: 'host-a' };

  it('when no connection in the file carries a credential, only requires edit permission (existing behavior preserved)', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    dbMock.one.mockResolvedValue({ id: 'new-conn-1' });

    const res = await request(buildApp())
      .post('/api/admin/lists/list-1/connections/import')
      .send({ schema_version: 1, connections: [baseConnection] });

    expect(res.status).toBe(200);
    expect(permissionsMock.requireListPermission).toHaveBeenCalledWith('user-1', 'list-1', 'edit');
    expect(res.body.importedCredentials).toBe(0);
  });

  it('when ANY connection in the file carries a credential, requires admin for the whole import — checked upfront, before any row is written', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(false);

    const res = await request(buildApp()).post('/api/admin/lists/list-1/connections/import').send({
      schema_version: 1,
      connections: [
        baseConnection,
        { ...baseConnection, name: 'Host B', credential_username_encrypted: 'vault:v1:u', credential_secret_encrypted: 'vault:v1:s' }
      ]
    });

    expect(res.status).toBe(403);
    expect(permissionsMock.requireListPermission).toHaveBeenCalledWith('user-1', 'list-1', 'admin');
    expect(dbMock.one).not.toHaveBeenCalled();
    expect(dbMock.none).not.toHaveBeenCalled();
  });

  it('on a permitted import of a shared connection with a credential, inserts it scoped to user_id NULL, copying the ciphertext through unchanged — never decrypted or re-encrypted', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    dbMock.one.mockResolvedValue({ id: 'new-conn-1' });

    const res = await request(buildApp()).post('/api/admin/lists/list-1/connections/import').send({
      schema_version: 1,
      connections: [{ ...baseConnection, credential_mode: 'shared', credential_username_encrypted: 'vault:v1:untouched-u', credential_secret_encrypted: 'vault:v1:untouched-s' }]
    });

    expect(res.status).toBe(200);
    expect(res.body.importedCredentials).toBe(1);
    expect(dbMock.none).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO connection_credentials'),
      ['new-conn-1', null, 'vault:v1:untouched-u', 'vault:v1:untouched-s']
    );
  });

  it('on a permitted import of an INDIVIDUAL connection with a credential, scopes it to the importing user — mirroring the export side\\'s identical reasoning: the credential this file carries was only ever the exporting user\\'s own in the first place, so attributing it to whoever is now importing it is correct, not a different user\\'s row being reassigned', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    dbMock.one.mockResolvedValue({ id: 'new-conn-1' });

    const res = await request(buildApp('importing-user')).post('/api/admin/lists/list-1/connections/import').send({
      schema_version: 1,
      connections: [{ ...baseConnection, credential_mode: 'individual', credential_username_encrypted: 'vault:v1:indiv-u', credential_secret_encrypted: 'vault:v1:indiv-s' }]
    });

    expect(res.status).toBe(200);
    expect(res.body.importedCredentials).toBe(1);
    expect(dbMock.none).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO connection_credentials'),
      ['new-conn-1', 'importing-user', 'vault:v1:indiv-u', 'vault:v1:indiv-s']
    );
  });

  it('still skips malformed connection rows rather than failing the whole import, credentials or not', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    dbMock.one.mockResolvedValue({ id: 'new-conn-1' });

    const res = await request(buildApp()).post('/api/admin/lists/list-1/connections/import').send({
      schema_version: 1,
      connections: [{ name: 'Missing protocol and hostname' }, baseConnection]
    });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(1);
  });

  it('skips (not silently downgrades) an ad_passthrough row when AD is not enabled on this deployment', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    dbMock.one.mockResolvedValue({ id: 'new-conn-1' });
    adMock.isAdEnabled.mockReturnValueOnce(false);

    const res = await request(buildApp()).post('/api/admin/lists/list-1/connections/import').send({
      schema_version: 1,
      connections: [{ ...baseConnection, credential_mode: 'ad_passthrough' }]
    });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(dbMock.one).not.toHaveBeenCalled();
  });

  it('preserves an ad_passthrough row\'s own mode when AD is enabled, rather than defaulting it to shared', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    dbMock.one.mockResolvedValue({ id: 'new-conn-1' });
    adMock.isAdEnabled.mockReturnValueOnce(true);

    const res = await request(buildApp()).post('/api/admin/lists/list-1/connections/import').send({
      schema_version: 1,
      connections: [{ ...baseConnection, credential_mode: 'ad_passthrough' }]
    });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    const insertArgs = dbMock.one.mock.calls[0][1];
    expect(insertArgs[5]).toBe('ad_passthrough'); // credential_mode positional param
  });
});

describe('POST /api/admin/lists/:listId/connections (create)', () => {
  it('rejects a garbage credentialMode with a clean 400, not a raw database error', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);

    const res = await request(buildApp()).post('/api/admin/lists/list-1/connections').send({
      name: 'Host A', protocol: 'ssh', hostname: 'host-a', port: 22, credentialMode: 'nonsense'
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_credential_mode');
    expect(dbMock.one).not.toHaveBeenCalled();
  });

  it('rejects ad_passthrough outright when AD is not enabled on this deployment, even via a direct API call bypassing the form\'s own gating', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    adMock.isAdEnabled.mockReturnValueOnce(false);

    const res = await request(buildApp()).post('/api/admin/lists/list-1/connections').send({
      name: 'Host A', protocol: 'rdp', hostname: 'host-a', port: 3389, credentialMode: 'ad_passthrough'
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ad_not_configured');
    expect(dbMock.one).not.toHaveBeenCalled();
  });

  it('accepts ad_passthrough when AD is enabled', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    adMock.isAdEnabled.mockReturnValueOnce(true);
    dbMock.one.mockResolvedValue({ id: 'new-conn-1' });

    const res = await request(buildApp()).post('/api/admin/lists/list-1/connections').send({
      name: 'Host A', protocol: 'rdp', hostname: 'host-a', port: 3389, credentialMode: 'ad_passthrough'
    });

    expect(res.status).toBe(200);
    expect(dbMock.one).toHaveBeenCalled();
  });
});

describe('PUT /api/admin/connections/:id (update)', () => {
  it('rejects a garbage credentialMode with a clean 400, leaving the connection untouched', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    dbMock.one.mockResolvedValue({ list_id: 'list-1' });

    const res = await request(buildApp()).put('/api/admin/connections/conn-1').send({
      name: 'Host A', hostname: 'host-a', port: 22, credentialMode: 'nonsense'
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_credential_mode');
    expect(dbMock.none).not.toHaveBeenCalled();
  });

  it('rejects switching to ad_passthrough when AD is not enabled', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    dbMock.one.mockResolvedValue({ list_id: 'list-1' });
    adMock.isAdEnabled.mockReturnValueOnce(false);

    const res = await request(buildApp()).put('/api/admin/connections/conn-1').send({
      name: 'Host A', hostname: 'host-a', port: 3389, credentialMode: 'ad_passthrough'
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ad_not_configured');
    expect(dbMock.none).not.toHaveBeenCalled();
  });

  it('allows switching to ad_passthrough when AD is enabled', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    dbMock.one.mockResolvedValue({ list_id: 'list-1' });
    adMock.isAdEnabled.mockReturnValueOnce(true);
    dbMock.none.mockResolvedValue(undefined);

    const res = await request(buildApp()).put('/api/admin/connections/conn-1').send({
      name: 'Host A', hostname: 'host-a', port: 3389, credentialMode: 'ad_passthrough'
    });

    expect(res.status).toBe(200);
    const updateArgs = dbMock.none.mock.calls[0][1];
    expect(updateArgs[6]).toBe('ad_passthrough'); // credential_mode positional param
  });

  it('leaving credentialMode out entirely still updates other fields, unaffected by the new validation', async () => {
    permissionsMock.requireListPermission.mockResolvedValue(true);
    dbMock.one.mockResolvedValue({ list_id: 'list-1' });
    dbMock.none.mockResolvedValue(undefined);

    const res = await request(buildApp()).put('/api/admin/connections/conn-1').send({
      name: 'Renamed Host', hostname: 'host-a', port: 22
    });

    expect(res.status).toBe(200);
    const updateArgs = dbMock.none.mock.calls[0][1];
    expect(updateArgs[6]).toBeNull(); // COALESCE(NULL, credential_mode) — leaves the existing value alone
  });
});

describe('GET /api/admin/ad-status', () => {
  it('reflects whatever isAdEnabled() itself currently reports, for any authenticated user (not admin-only — see the route\'s own comment)', async () => {
    adMock.isAdEnabled.mockReturnValueOnce(true);

    const res = await request(buildApp()).get('/api/admin/ad-status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it('the real bug this guards against: a non-admin user (isAdministrator would say false) still gets a real answer, not a 403', async () => {
    dbMock.oneOrNone.mockResolvedValue(null); // isAdministrator's own check, failing — this user is NOT an admin
    adMock.isAdEnabled.mockReturnValueOnce(true);

    const res = await request(buildApp()).get('/api/admin/ad-status');

    // AddConnectionForm.tsx is specifically the non-admin-facing
    // connection form — if this route required admin, every non-admin
    // user would be permanently unable to see AD passthrough as an
    // option at all, even on a deployment where it's fully enabled.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });
});

describe('DELETE /api/admin/users/:id', () => {
  it('disables the account and clears any cached AD passthrough credential for it — no existing coverage for this route before this test', async () => {
    dbMock.oneOrNone.mockResolvedValue({ '?column?': 1 }); // isAdministrator's own check, passing
    dbMock.none.mockResolvedValue(undefined);

    const res = await request(buildApp()).delete('/api/admin/users/target-user-1');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disabled');
    expect(dbMock.none).toHaveBeenCalledWith(expect.stringContaining('disabled_at = now()'), ['target-user-1']);
    // The real point of this test: an admin's disable should take
    // immediate effect on a cached AD password too, not wait out
    // whatever's left of that row's own separate expiry.
    expect(adMock.clearAdPassthroughCredential).toHaveBeenCalledWith('target-user-1');
    expect(auditMock.logAuditFromRequest).toHaveBeenCalledWith(expect.anything(), 'user_disabled', { targetUserId: 'target-user-1' });
  });
});

describe('POST /api/admin/users/:id/remove', () => {
  // isAdministrator (requireAdmin's own check on the requester, and
  // this route's own separate check on the removal target) both go
  // through dbMock.oneOrNone, called in a fixed order each request —
  // mocked here as a strict sequence of resolved values per call,
  // matching that order, rather than one flat value for every call.

  it('removes a non-admin target for a real admin requester', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ '?column?': 1 }); // requireAdmin's own check
    dbMock.oneOrNone.mockResolvedValueOnce(null); // isAdministrator(target) — not an admin
    dbMock.oneOrNone.mockResolvedValueOnce({ username: 'bob' }); // the route's own user lookup
    userRemovalMock.removeUser.mockResolvedValue(undefined);

    const app = buildApp('user-1');
    const res = await request(app).post('/api/admin/users/target-1/remove');

    expect(res.status).toBe(200);
    expect(userRemovalMock.removeUser).toHaveBeenCalledWith('target-1');
    expect(auditMock.logAuditFromRequest).toHaveBeenCalledWith(
      expect.anything(), 'user_removed', { targetUserId: 'target-1', targetUsername: 'bob' },
    );
  });

  it('refuses to remove your own account, and never calls removeUser', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ '?column?': 1 }); // requireAdmin's own check
    const app = buildApp('user-1');
    const res = await request(app).post('/api/admin/users/user-1/remove');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cannot_remove_self');
    expect(userRemovalMock.removeUser).not.toHaveBeenCalled();
  });

  it('refuses to remove the last remaining Administrator', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ '?column?': 1 }); // requireAdmin's own check
    dbMock.oneOrNone.mockResolvedValueOnce({ '?column?': 1 }); // isAdministrator(target) — yes, they are
    dbMock.one.mockResolvedValue({ count: '1' });
    const app = buildApp('user-1');
    const res = await request(app).post('/api/admin/users/last-admin/remove');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cannot_remove_last_administrator');
    expect(userRemovalMock.removeUser).not.toHaveBeenCalled();
  });

  it('allows removing an admin when at least one other Administrator remains', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ '?column?': 1 }); // requireAdmin's own check
    dbMock.oneOrNone.mockResolvedValueOnce({ '?column?': 1 }); // isAdministrator(target) — yes
    dbMock.one.mockResolvedValue({ count: '2' });
    dbMock.oneOrNone.mockResolvedValueOnce({ username: 'alice' }); // the route's own user lookup
    userRemovalMock.removeUser.mockResolvedValue(undefined);
    const app = buildApp('user-1');
    const res = await request(app).post('/api/admin/users/other-admin/remove');
    expect(res.status).toBe(200);
    expect(userRemovalMock.removeUser).toHaveBeenCalledWith('other-admin');
  });

  it('404s for a target that no longer exists, without calling removeUser', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ '?column?': 1 }); // requireAdmin's own check
    dbMock.oneOrNone.mockResolvedValueOnce(null); // isAdministrator(target) — not an admin
    dbMock.oneOrNone.mockResolvedValueOnce(null); // the route's own user lookup — gone
    const app = buildApp('user-1');
    const res = await request(app).post('/api/admin/users/ghost/remove');
    expect(res.status).toBe(404);
    expect(userRemovalMock.removeUser).not.toHaveBeenCalled();
  });
});
