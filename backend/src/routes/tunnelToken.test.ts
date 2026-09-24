import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ oneOrNone: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const hasConnectionAccessMock = vi.hoisted(() => vi.fn());
const isAdministratorMock = vi.hoisted(() => vi.fn());
vi.mock('../services/permissions', () => ({ hasConnectionAccess: hasConnectionAccessMock, isAdministrator: isAdministratorMock }));

const decryptCredentialMock = vi.hoisted(() => vi.fn());
vi.mock('../services/vaultClient', () => ({ decryptCredential: decryptCredentialMock }));

const getAdPassthroughCredentialMock = vi.hoisted(() => vi.fn());
vi.mock('../services/activeDirectory', () => ({ getAdPassthroughCredential: getAdPassthroughCredentialMock }));

const createDriveMock = vi.hoisted(() => vi.fn());
vi.mock('../services/rdpDriveManager', () => ({ createDrive: createDriveMock }));

const encryptGuacTokenMock = vi.hoisted(() => vi.fn((_payload: any) => 'encrypted-token-value'));
vi.mock('../services/guacToken', () => ({ encryptGuacToken: encryptGuacTokenMock }));

import { issueNewConnectionToken, issueAdhocConnectionToken } from './tunnelToken';

function baseConnectionRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'conn-1',
    list_id: 'list-1',
    protocol: 'ssh',
    hostname: '10.0.0.5',
    port: 22,
    credential_mode: 'individual',
    params: {},
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  decryptCredentialMock.mockImplementation(async (c: string) => (c.includes('user') ? 'the-username' : 'the-password'));
});

describe('issueNewConnectionToken', () => {
  it('returns connection_not_found for a nonexistent connection, before checking anything else', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(null);
    const result = await issueNewConnectionToken('user-1', 'missing-conn');
    expect(result).toEqual({ status: 'connection_not_found' });
    expect(hasConnectionAccessMock).not.toHaveBeenCalled();
  });

  it('returns not_authorized when access is denied, before touching credentials', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(baseConnectionRow());
    hasConnectionAccessMock.mockResolvedValueOnce(false);

    const result = await issueNewConnectionToken('user-1', 'conn-1');
    expect(result).toEqual({ status: 'not_authorized' });
    expect(decryptCredentialMock).not.toHaveBeenCalled();
  });

  it('returns no_credentials_configured when authorized but nothing is set up', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(baseConnectionRow()).mockResolvedValueOnce(null);
    hasConnectionAccessMock.mockResolvedValueOnce(true);

    const result = await issueNewConnectionToken('user-1', 'conn-1');
    expect(result).toEqual({ status: 'no_credentials_configured' });
  });

  it('scopes an individual-mode credential lookup to the specific user', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce(baseConnectionRow({ credential_mode: 'individual' }))
      .mockResolvedValueOnce({ username_encrypted: 'enc-user', secret_encrypted: 'enc-pass' });
    hasConnectionAccessMock.mockResolvedValueOnce(true);

    await issueNewConnectionToken('user-1', 'conn-1');

    const [, args] = dbMock.oneOrNone.mock.calls[1];
    expect(args).toEqual(['conn-1', 'user-1']);
  });

  it('scopes a shared-mode credential lookup to NULL, not the caller', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce(baseConnectionRow({ credential_mode: 'shared' }))
      .mockResolvedValueOnce({ username_encrypted: 'enc-user', secret_encrypted: 'enc-pass' });
    hasConnectionAccessMock.mockResolvedValueOnce(true);

    await issueNewConnectionToken('user-1', 'conn-1');

    const [, args] = dbMock.oneOrNone.mock.calls[1];
    expect(args).toEqual(['conn-1', null]);
  });

  it('an ad_passthrough connection uses the caller\'s own captured AD credential, never touching connection_credentials at all', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(baseConnectionRow({ credential_mode: 'ad_passthrough' }));
    hasConnectionAccessMock.mockResolvedValueOnce(true);
    getAdPassthroughCredentialMock.mockResolvedValueOnce({ username: 'DOMAIN\\alice', password: 'alices-ad-password' });

    const result = await issueNewConnectionToken('user-1', 'conn-1');

    expect(result.status).toBe('ok');
    expect(getAdPassthroughCredentialMock).toHaveBeenCalledWith('user-1');
    // Only the one oneOrNone call (the connection lookup itself) — no
    // second query against connection_credentials for this mode at all.
    expect(dbMock.oneOrNone).toHaveBeenCalledTimes(1);
    expect(decryptCredentialMock).not.toHaveBeenCalled();
  });

  it('returns ad_credential_unavailable, not no_credentials_configured, when this user has no captured AD credential right now', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(baseConnectionRow({ credential_mode: 'ad_passthrough' }));
    hasConnectionAccessMock.mockResolvedValueOnce(true);
    getAdPassthroughCredentialMock.mockResolvedValueOnce(null);

    const result = await issueNewConnectionToken('user-1', 'conn-1');

    expect(result).toEqual({ status: 'ad_credential_unavailable' });
  });

  it('embeds the fully-decrypted connection settings directly into the token payload', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce(baseConnectionRow())
      .mockResolvedValueOnce({ username_encrypted: 'enc-user', secret_encrypted: 'enc-pass' });
    hasConnectionAccessMock.mockResolvedValueOnce(true);

    const result = await issueNewConnectionToken('user-1', 'conn-1');

    expect(result).toEqual({ status: 'ok', token: 'encrypted-token-value' });
    const [tokenPayload] = encryptGuacTokenMock.mock.calls[0]!;
    expect(tokenPayload.connection.settings.username).toBe('the-username');
    expect(tokenPayload.connection.settings.password).toBe('the-password');
    expect(tokenPayload.connection.type).toBe('ssh');
    // Confirms the fix for the empirically-found race: the token must carry
    // a complete, ready-to-use connection object, not just userId/connectionId
    // for guacamole-lite to resolve asynchronously later.
    expect(tokenPayload.connection.settings.hostname).toBe('10.0.0.5');
  });

  it('includes an issuedAt timestamp for the synchronous freshness check in guacTunnel.ts', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce(baseConnectionRow())
      .mockResolvedValueOnce({ username_encrypted: 'enc-user', secret_encrypted: 'enc-pass' });
    hasConnectionAccessMock.mockResolvedValueOnce(true);

    await issueNewConnectionToken('user-1', 'conn-1');

    const [tokenPayload] = encryptGuacTokenMock.mock.calls[0]!;
    expect(typeof tokenPayload.issuedAt).toBe('number');
    expect(Date.now() - tokenPayload.issuedAt).toBeLessThan(1000);
  });

  it('sets up an RDP drive and includes rdpDriveId only for rdp connections', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce(baseConnectionRow({ protocol: 'rdp' }))
      .mockResolvedValueOnce({ username_encrypted: 'enc-user', secret_encrypted: 'enc-pass' });
    hasConnectionAccessMock.mockResolvedValueOnce(true);
    createDriveMock.mockReturnValueOnce('/data/rdp-drives/generated');

    await issueNewConnectionToken('user-1', 'conn-1');

    const [tokenPayload] = encryptGuacTokenMock.mock.calls[0]!;
    expect(tokenPayload.rdpDriveId).toBeTruthy();
    expect(tokenPayload.connection.settings['drive-path']).toBe('/data/rdp-drives/generated');
  });

  it('does not touch RDP drive setup at all for non-rdp protocols', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce(baseConnectionRow({ protocol: 'ssh' }))
      .mockResolvedValueOnce({ username_encrypted: 'enc-user', secret_encrypted: 'enc-pass' });
    hasConnectionAccessMock.mockResolvedValueOnce(true);

    await issueNewConnectionToken('user-1', 'conn-1');

    expect(createDriveMock).not.toHaveBeenCalled();
    const [tokenPayload] = encryptGuacTokenMock.mock.calls[0]!;
    expect(tokenPayload.rdpDriveId).toBeNull();
  });
});

// Requested directly ("ad-hoc connections"): fill in connection details
// directly and connect immediately, with nothing saved as a reusable
// connection record. The most important property here, checked first and
// most thoroughly: this must be genuinely admin-only, enforced here
// server-side, not just left to whatever the frontend happens to show or
// hide — every other connection in this app is reachable only because an
// admin explicitly granted it through the list-based permission model,
// and this bypasses that model entirely.
describe('issueAdhocConnectionToken', () => {
  const validInput = { protocol: 'ssh', hostname: '10.0.0.9', port: 22, username: 'root', password: 'hunter2' };

  it('returns not_authorized for a non-admin, before validating anything else about the input', async () => {
    isAdministratorMock.mockResolvedValueOnce(false);

    const result = await issueAdhocConnectionToken('user-1', {});

    expect(result).toEqual({ status: 'not_authorized' });
    expect(encryptGuacTokenMock).not.toHaveBeenCalled();
  });

  it('rejects an unsupported protocol even for an admin', async () => {
    isAdministratorMock.mockResolvedValueOnce(true);

    const result = await issueAdhocConnectionToken('admin-1', { ...validInput, protocol: 'telnet' });

    expect(result.status).toBe('invalid_input');
  });

  it('rejects a missing hostname', async () => {
    isAdministratorMock.mockResolvedValueOnce(true);

    const result = await issueAdhocConnectionToken('admin-1', { ...validInput, hostname: '' });

    expect(result.status).toBe('invalid_input');
  });

  it.each([0, -1, 65536, 1.5, NaN])('rejects an invalid port (%s)', async (port) => {
    isAdministratorMock.mockResolvedValueOnce(true);

    const result = await issueAdhocConnectionToken('admin-1', { ...validInput, port });

    expect(result.status).toBe('invalid_input');
  });

  it('accepts the full valid port range boundaries (1 and 65535)', async () => {
    isAdministratorMock.mockResolvedValue(true);

    const low = await issueAdhocConnectionToken('admin-1', { ...validInput, port: 1 });
    const high = await issueAdhocConnectionToken('admin-1', { ...validInput, port: 65535 });

    expect(low.status).toBe('ok');
    expect(high.status).toBe('ok');
  });

  it('builds a token with connectionId null — deliberately, there is no saved connection to reference', async () => {
    isAdministratorMock.mockResolvedValueOnce(true);

    await issueAdhocConnectionToken('admin-1', validInput);

    const [tokenPayload] = encryptGuacTokenMock.mock.calls[0]!;
    expect(tokenPayload.connectionId).toBeNull();
  });

  it('never queries connection_credentials or decrypts anything — credentials pass straight through, never persisted', async () => {
    isAdministratorMock.mockResolvedValueOnce(true);

    await issueAdhocConnectionToken('admin-1', validInput);

    expect(dbMock.oneOrNone).not.toHaveBeenCalled();
    expect(decryptCredentialMock).not.toHaveBeenCalled();
    const [tokenPayload] = encryptGuacTokenMock.mock.calls[0]!;
    expect(tokenPayload.connection.settings.username).toBe('root');
    expect(tokenPayload.connection.settings.password).toBe('hunter2');
  });

  it('sets up an RDP drive for an ad-hoc rdp connection, same as a saved one gets', async () => {
    isAdministratorMock.mockResolvedValueOnce(true);
    createDriveMock.mockReturnValueOnce('/data/rdp-drives/adhoc-generated');

    await issueAdhocConnectionToken('admin-1', { ...validInput, protocol: 'rdp' });

    const [tokenPayload] = encryptGuacTokenMock.mock.calls[0]!;
    expect(tokenPayload.rdpDriveId).toBeTruthy();
    expect(tokenPayload.connection.settings['drive-path']).toBe('/data/rdp-drives/adhoc-generated');
  });

  it('does not touch RDP drive setup at all for a non-rdp ad-hoc protocol', async () => {
    isAdministratorMock.mockResolvedValueOnce(true);

    await issueAdhocConnectionToken('admin-1', validInput);

    expect(createDriveMock).not.toHaveBeenCalled();
  });

  it('merges caller-supplied advanced params into the token settings', async () => {
    isAdministratorMock.mockResolvedValueOnce(true);

    await issueAdhocConnectionToken('admin-1', { ...validInput, params: { 'ignore-cert': true } });

    const [tokenPayload] = encryptGuacTokenMock.mock.calls[0]!;
    expect(tokenPayload.connection.settings['ignore-cert']).toBe(true);
  });

  it('ignores a non-object params value rather than letting it corrupt the token', async () => {
    isAdministratorMock.mockResolvedValueOnce(true);

    const result = await issueAdhocConnectionToken('admin-1', { ...validInput, params: 'not-an-object' as any });

    expect(result.status).toBe('ok');
  });
});
