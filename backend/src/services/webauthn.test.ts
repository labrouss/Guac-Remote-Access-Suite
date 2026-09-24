import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  one: vi.fn(),
  oneOrNone: vi.fn(),
  manyOrNone: vi.fn(),
  none: vi.fn(),
  result: vi.fn()
}));
vi.mock('../db', () => ({ db: dbMock }));

const waMock = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn()
}));
vi.mock('@simplewebauthn/server', () => waMock);

import {
  generatePasskeyRegistrationOptions,
  verifyAndStorePasskeyRegistration,
  generatePasskeyAuthenticationOptions,
  verifyPasskeyAuthentication,
  listPasskeysForUser,
  deletePasskey
} from './webauthn';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generatePasskeyRegistrationOptions', () => {
  it('excludes credentials the user has already registered, so the browser refuses to re-register the same physical passkey', async () => {
    dbMock.manyOrNone.mockResolvedValue([
      { credential_id: 'existing-cred-1', transports: ['internal'] },
      { credential_id: 'existing-cred-2', transports: null }
    ]);
    waMock.generateRegistrationOptions.mockResolvedValue({ challenge: 'chal' });

    await generatePasskeyRegistrationOptions('user-1', 'alice');

    const callArgs = waMock.generateRegistrationOptions.mock.calls[0][0];
    expect(callArgs.excludeCredentials).toEqual([
      { id: 'existing-cred-1', transports: ['internal'] },
      { id: 'existing-cred-2', transports: undefined }
    ]);
    expect(callArgs.userName).toBe('alice');
  });
});

describe('verifyAndStorePasskeyRegistration', () => {
  it('stores the credential on a verified response, using the fields the library actually returns', async () => {
    waMock.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: 'new-cred', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['usb'] },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false
      }
    });

    const result = await verifyAndStorePasskeyRegistration('user-1', 'expected-challenge', {} as any, 'My Key');

    expect(result).toEqual({ ok: true });
    expect(dbMock.none).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webauthn_credentials'),
      ['user-1', 'new-cred', Buffer.from([1, 2, 3]), 0, ['usb'], 'singleDevice', false, 'My Key']
    );
  });

  it('does not store anything when verification reports unverified', async () => {
    waMock.verifyRegistrationResponse.mockResolvedValue({ verified: false });

    const result = await verifyAndStorePasskeyRegistration('user-1', 'expected-challenge', {} as any, 'My Key');

    expect(result.ok).toBe(false);
    expect(dbMock.none).not.toHaveBeenCalled();
  });

  it('does not store anything when the library throws (a malformed or forged response)', async () => {
    waMock.verifyRegistrationResponse.mockRejectedValue(new Error('bad response'));

    const result = await verifyAndStorePasskeyRegistration('user-1', 'expected-challenge', {} as any, 'My Key');

    expect(result.ok).toBe(false);
    expect(dbMock.none).not.toHaveBeenCalled();
  });
});

describe('generatePasskeyAuthenticationOptions', () => {
  it('passes no allowCredentials — the usernameless flow depends on the authenticator surfacing its own passkeys, not this app pre-selecting one', async () => {
    waMock.generateAuthenticationOptions.mockResolvedValue({ challenge: 'chal' });

    await generatePasskeyAuthenticationOptions();

    const callArgs = waMock.generateAuthenticationOptions.mock.calls[0][0];
    expect(callArgs.allowCredentials).toBeUndefined();
  });
});

describe('verifyPasskeyAuthentication', () => {
  it('fails closed when no stored credential matches the response id — never calls into the verification library with nothing to check against', async () => {
    dbMock.oneOrNone.mockResolvedValue(null);

    const result = await verifyPasskeyAuthentication('challenge', { id: 'unknown-cred' } as any);

    expect(result).toEqual({ ok: false });
    expect(waMock.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('fails when the library reports unverified, and does not update the stored counter', async () => {
    dbMock.oneOrNone.mockResolvedValue({
      id: 'row-1', user_id: 'user-1', credential_id: 'cred-1', public_key: Buffer.from([9, 9]), counter: '3', transports: null
    });
    waMock.verifyAuthenticationResponse.mockResolvedValue({ verified: false });

    const result = await verifyPasskeyAuthentication('challenge', { id: 'cred-1' } as any);

    expect(result).toEqual({ ok: false });
    expect(dbMock.none).not.toHaveBeenCalled();
  });

  it('on a verified response, updates the stored counter to the new value and returns the owning userId', async () => {
    dbMock.oneOrNone.mockResolvedValue({
      id: 'row-1', user_id: 'user-1', credential_id: 'cred-1', public_key: Buffer.from([9, 9]), counter: '3', transports: ['internal']
    });
    waMock.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 4 }
    });

    const result = await verifyPasskeyAuthentication('challenge', { id: 'cred-1' } as any);

    expect(result).toEqual({ ok: true, userId: 'user-1' });
    expect(dbMock.none).toHaveBeenCalledWith(expect.stringContaining('UPDATE webauthn_credentials'), [4, 'row-1']);
    // The stored (string, from bigint) counter is passed to the library
    // as a real number, not left as a string it would fail to compare
    // numerically against the authenticator's own reported counter.
    const verifyCallArgs = waMock.verifyAuthenticationResponse.mock.calls[0][0];
    expect(verifyCallArgs.credential.counter).toBe(3);
    expect(typeof verifyCallArgs.credential.counter).toBe('number');
  });
});

describe('listPasskeysForUser / deletePasskey', () => {
  it('lists ordered by creation time, without ever selecting the public key', async () => {
    dbMock.manyOrNone.mockResolvedValue([]);
    await listPasskeysForUser('user-1');
    const query = dbMock.manyOrNone.mock.calls[0][0];
    expect(query).not.toMatch(/public_key/);
    expect(query).toMatch(/ORDER BY created_at ASC/);
  });

  it('deletePasskey scopes the delete to the given userId, so one account can never remove another\'s passkey', async () => {
    dbMock.result.mockResolvedValue({ rowCount: 1 });
    const deleted = await deletePasskey('user-1', 'cred-row-1');
    expect(deleted).toBe(true);
    expect(dbMock.result).toHaveBeenCalledWith(expect.any(String), ['cred-row-1', 'user-1']);
  });

  it('deletePasskey reports false, not an error, when nothing matched', async () => {
    dbMock.result.mockResolvedValue({ rowCount: 0 });
    const deleted = await deletePasskey('user-1', 'someone-elses-row');
    expect(deleted).toBe(false);
  });
});
