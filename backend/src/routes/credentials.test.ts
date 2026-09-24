import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  one: vi.fn(),
  oneOrNone: vi.fn(),
  none: vi.fn()
}));
vi.mock('../db', () => ({ db: dbMock }));

const requireListPermissionMock = vi.hoisted(() => vi.fn());
vi.mock('../services/permissions', () => ({ requireListPermission: requireListPermissionMock }));

const encryptCredentialMock = vi.hoisted(() => vi.fn());
vi.mock('../services/vaultClient', () => ({ encryptCredential: encryptCredentialMock }));

import {
  requiredPermissionForCredentialMode,
  credentialTargetUserId,
  writeConnectionCredential,
  getConnectionCredentialStatus
} from './credentials';

beforeEach(() => {
  vi.clearAllMocks();
  encryptCredentialMock.mockImplementation(async (plaintext: string) => `vault:v1:enc(${plaintext})`);
});

describe('requiredPermissionForCredentialMode', () => {
  it('requires admin for shared mode', () => {
    expect(requiredPermissionForCredentialMode('shared')).toBe('admin');
  });

  it('requires only connect for individual mode', () => {
    expect(requiredPermissionForCredentialMode('individual')).toBe('connect');
  });
});

describe('credentialTargetUserId', () => {
  it('scopes individual mode to the caller', () => {
    expect(credentialTargetUserId('individual', 'user-1')).toBe('user-1');
  });

  it('scopes shared mode to NULL, never the caller\'s own id', () => {
    // The one bug this function exists specifically to prevent: if shared
    // mode ever returned the caller's userId instead of null, the credential
    // would only ever resolve for that one user, and every other
    // connect-level user would silently see "no credentials configured".
    expect(credentialTargetUserId('shared', 'user-1')).toBeNull();
  });
});

describe('writeConnectionCredential', () => {
  it('rejects an individual-mode write when the caller lacks connect', async () => {
    dbMock.one.mockResolvedValue({ list_id: 'list-1', credential_mode: 'individual' });
    requireListPermissionMock.mockResolvedValue(false);

    const result = await writeConnectionCredential('user-1', 'conn-1', 'alice', 'hunter2');

    expect(result).toEqual({ status: 'not_authorized' });
    expect(requireListPermissionMock).toHaveBeenCalledWith('user-1', 'list-1', 'connect');
    // Never even attempts encryption/write once denied.
    expect(encryptCredentialMock).not.toHaveBeenCalled();
    expect(dbMock.none).not.toHaveBeenCalled();
  });

  it('rejects a shared-mode write from a user with only connect, not admin', async () => {
    dbMock.one.mockResolvedValue({ list_id: 'list-1', credential_mode: 'shared' });
    requireListPermissionMock.mockResolvedValue(false);

    const result = await writeConnectionCredential('user-1', 'conn-1', 'svc-account', 'hunter2');

    expect(result).toEqual({ status: 'not_authorized' });
    // The critical check: shared mode must have been gated on 'admin', not 'connect'.
    expect(requireListPermissionMock).toHaveBeenCalledWith('user-1', 'list-1', 'admin');
  });

  it('writes an individual credential scoped to the caller, encrypting both fields', async () => {
    dbMock.one.mockResolvedValue({ list_id: 'list-1', credential_mode: 'individual' });
    requireListPermissionMock.mockResolvedValue(true);

    const result = await writeConnectionCredential('user-1', 'conn-1', 'alice', 'hunter2');

    expect(result).toEqual({ status: 'saved' });
    expect(encryptCredentialMock).toHaveBeenCalledWith('alice');
    expect(encryptCredentialMock).toHaveBeenCalledWith('hunter2');

    const insertCall = dbMock.none.mock.calls.find(([sql]) => sql.includes('INSERT INTO connection_credentials'));
    expect(insertCall![1]).toEqual(['conn-1', 'user-1', 'vault:v1:enc(alice)', 'vault:v1:enc(hunter2)']);
  });

  it('writes a shared credential with a NULL user scope, not the writer\'s own id', async () => {
    dbMock.one.mockResolvedValue({ list_id: 'list-1', credential_mode: 'shared' });
    requireListPermissionMock.mockResolvedValue(true);

    await writeConnectionCredential('admin-user', 'conn-1', 'svc-account', 'hunter2');

    const insertCall = dbMock.none.mock.calls.find(([sql]) => sql.includes('INSERT INTO connection_credentials'));
    // Second bound parameter (user_id) must be null, not 'admin-user' — this
    // is the exact scoping bug credentialTargetUserId is tested against
    // above, re-verified here at the full write-path level.
    expect(insertCall![1]).toEqual(['conn-1', null, 'vault:v1:enc(svc-account)', 'vault:v1:enc(hunter2)']);
  });

  it('logs a credential_updated audit entry only after a successful write', async () => {
    dbMock.one.mockResolvedValue({ list_id: 'list-1', credential_mode: 'individual' });
    requireListPermissionMock.mockResolvedValue(true);

    await writeConnectionCredential('user-1', 'conn-1', 'alice', 'hunter2');

    const auditCall = dbMock.none.mock.calls.find(([sql]) => sql.includes('INSERT INTO audit_log'));
    expect(auditCall).toBeDefined();
    expect(auditCall![1][0]).toBe('user-1');
    expect(auditCall![1][1]).toBe('conn-1');
  });

  it('does not log an audit entry when the write is rejected for lack of authorization', async () => {
    dbMock.one.mockResolvedValue({ list_id: 'list-1', credential_mode: 'shared' });
    requireListPermissionMock.mockResolvedValue(false);

    await writeConnectionCredential('user-1', 'conn-1', 'alice', 'hunter2');

    expect(dbMock.none).not.toHaveBeenCalled();
  });
});

describe('getConnectionCredentialStatus', () => {
  it('checks individual mode scoped to the requesting user', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ credential_mode: 'individual' }).mockResolvedValueOnce({ '?column?': 1 });

    const result = await getConnectionCredentialStatus('user-1', 'conn-1');

    expect(result).toEqual({ configured: true, mode: 'individual' });
    const [, args] = dbMock.oneOrNone.mock.calls[1];
    expect(args).toEqual(['conn-1', 'user-1']);
  });

  it('checks shared mode with NULL scoping, not the requesting user\'s id', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ credential_mode: 'shared' }).mockResolvedValueOnce(null);

    const result = await getConnectionCredentialStatus('user-1', 'conn-1');

    expect(result).toEqual({ configured: false, mode: 'shared' });
    const [, args] = dbMock.oneOrNone.mock.calls[1];
    expect(args).toEqual(['conn-1', null]);
  });

  it('reports unconfigured without throwing when no credential row exists yet', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ credential_mode: 'individual' }).mockResolvedValueOnce(null);

    await expect(getConnectionCredentialStatus('user-1', 'conn-1')).resolves.toEqual({
      configured: false,
      mode: 'individual'
    });
  });

  // Real bug found live: a connection that no longer exists (deleted,
  // or a stale reference) made this throw via db.one()'s zero-rows
  // behavior, surfacing as an opaque 500 to the frontend instead of a
  // clear "not found". Switched to db.oneOrNone and this null return —
  // confirmed here, not just assumed, that a missing connection now
  // resolves cleanly instead of throwing.
  it('returns null, not a thrown error, when the connection does not exist', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(null);

    const result = await getConnectionCredentialStatus('user-1', 'conn-1');

    expect(result).toBeNull();
    expect(dbMock.oneOrNone).toHaveBeenCalledTimes(1); // never reaches the second, credential-existence query
  });
});
