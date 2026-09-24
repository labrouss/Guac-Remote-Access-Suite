import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// node-fetch is mocked at the module boundary; each test gets a fresh
// mock function via vi.resetModules() + a dynamic re-import below, since
// vaultClient.ts holds cachedToken/tokenExpiresAt as module-level mutable
// state — without resetting the module registry, one test's cached token
// would leak into the next test's assertions about cache misses.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('node-fetch', () => ({ default: fetchMock }));

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function loginResponse(leaseDurationSeconds: number) {
  return jsonResponse({ auth: { client_token: 'vault-token-abc', lease_duration: leaseDurationSeconds } });
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  process.env.VAULT_ADDR = 'https://vault.test';
  process.env.VAULT_ROLE_ID = 'role-1';
  process.env.VAULT_SECRET_ID = 'secret-1';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getVaultToken caching (exercised indirectly via encryptCredential)', () => {
  it('logs in once and reuses the cached token for a second call within the lease window', async () => {
    const { encryptCredential } = await import('./vaultClient');

    fetchMock
      .mockResolvedValueOnce(loginResponse(3600)) // AppRole login for the 1st encrypt call
      .mockResolvedValueOnce(jsonResponse({ data: { ciphertext: 'vault:v1:one' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { ciphertext: 'vault:v1:two' } })); // 2nd encrypt call — no 2nd login expected

    await encryptCredential('secret-one');
    await encryptCredential('secret-two');

    // Exactly 3 fetch calls total (1 login + 2 encrypts), not 4 — the
    // second encrypt must NOT trigger a second AppRole login.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const loginCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/approle/login'));
    expect(loginCalls).toHaveLength(1);
  });

  it('re-logs in once the cached token has passed its refresh point', async () => {
    const { encryptCredential } = await import('./vaultClient');

    fetchMock
      .mockResolvedValueOnce(loginResponse(120)) // short lease: refreshes 60s early, so expires functionally at +60s
      .mockResolvedValueOnce(jsonResponse({ data: { ciphertext: 'vault:v1:one' } }));

    await encryptCredential('secret-one');

    // Advance well past the 60-second effective expiry (lease_duration - 60).
    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'));

    fetchMock
      .mockResolvedValueOnce(loginResponse(120)) // expect a second login here
      .mockResolvedValueOnce(jsonResponse({ data: { ciphertext: 'vault:v1:two' } }));

    await encryptCredential('secret-two');

    const loginCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/approle/login'));
    expect(loginCalls).toHaveLength(2);
  });

  it('propagates an error when the AppRole login itself fails, without masking it as an encrypt failure', async () => {
    const { encryptCredential } = await import('./vaultClient');
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 403));

    await expect(encryptCredential('secret-one')).rejects.toThrow('Vault AppRole login failed: 403');
  });
});

describe('encryptCredential / decryptCredential request shape', () => {
  it('base64-encodes the plaintext before sending it to the transit encrypt endpoint', async () => {
    const { encryptCredential } = await import('./vaultClient');
    fetchMock
      .mockResolvedValueOnce(loginResponse(3600))
      .mockResolvedValueOnce(jsonResponse({ data: { ciphertext: 'vault:v1:enc' } }));

    await encryptCredential('hunter2');

    const [, encryptCall] = fetchMock.mock.calls;
    const [url, options] = encryptCall;
    expect(url).toContain('/v1/transit/encrypt/guac-credentials');
    const body = JSON.parse((options as any).body);
    expect(body.plaintext).toBe(Buffer.from('hunter2').toString('base64'));
    expect((options as any).headers['X-Vault-Token']).toBe('vault-token-abc');
  });

  it('returns the ciphertext string as-is from a successful encrypt response', async () => {
    const { encryptCredential } = await import('./vaultClient');
    fetchMock
      .mockResolvedValueOnce(loginResponse(3600))
      .mockResolvedValueOnce(jsonResponse({ data: { ciphertext: 'vault:v1:abc123' } }));

    await expect(encryptCredential('hunter2')).resolves.toBe('vault:v1:abc123');
  });

  it('base64-decodes the plaintext returned from the transit decrypt endpoint', async () => {
    const { decryptCredential } = await import('./vaultClient');
    const encodedPlaintext = Buffer.from('hunter2').toString('base64');
    fetchMock
      .mockResolvedValueOnce(loginResponse(3600))
      .mockResolvedValueOnce(jsonResponse({ data: { plaintext: encodedPlaintext } }));

    await expect(decryptCredential('vault:v1:abc123')).resolves.toBe('hunter2');
  });

  it('sends the raw ciphertext (not re-encoded) to the transit decrypt endpoint', async () => {
    const { decryptCredential } = await import('./vaultClient');
    fetchMock
      .mockResolvedValueOnce(loginResponse(3600))
      .mockResolvedValueOnce(jsonResponse({ data: { plaintext: Buffer.from('x').toString('base64') } }));

    await decryptCredential('vault:v1:untouched-ciphertext');

    const [, decryptCall] = fetchMock.mock.calls;
    const [url, options] = decryptCall;
    expect(url).toContain('/v1/transit/decrypt/guac-credentials');
    const body = JSON.parse((options as any).body);
    expect(body.ciphertext).toBe('vault:v1:untouched-ciphertext');
  });

  it('throws when the encrypt call itself fails', async () => {
    const { encryptCredential } = await import('./vaultClient');
    fetchMock.mockResolvedValueOnce(loginResponse(3600)).mockResolvedValueOnce(jsonResponse({}, false, 500));

    await expect(encryptCredential('hunter2')).rejects.toThrow('Vault encrypt failed: 500');
  });

  it('throws when the decrypt call itself fails', async () => {
    const { decryptCredential } = await import('./vaultClient');
    fetchMock.mockResolvedValueOnce(loginResponse(3600)).mockResolvedValueOnce(jsonResponse({}, false, 500));

    await expect(decryptCredential('vault:v1:x')).rejects.toThrow('Vault decrypt failed: 500');
  });
});

describe('checkVaultHealth', () => {
  it('treats any response under 500 as reachable, including Vault standby (429)', async () => {
    const { checkVaultHealth } = await import('./vaultClient');
    fetchMock.mockResolvedValueOnce({ status: 429 });
    expect(await checkVaultHealth('https://vault.test')).toBe(true);
  });

  it('treats a 5xx response as unreachable/unhealthy', async () => {
    const { checkVaultHealth } = await import('./vaultClient');
    fetchMock.mockResolvedValueOnce({ status: 503 });
    expect(await checkVaultHealth('https://vault.test')).toBe(false);
  });

  it('treats a network-level failure (fetch throwing) as unhealthy, not an uncaught rejection', async () => {
    const { checkVaultHealth } = await import('./vaultClient');
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(checkVaultHealth('https://vault.test')).resolves.toBe(false);
  });
});
