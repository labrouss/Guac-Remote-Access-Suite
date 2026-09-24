import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { encryptGuacToken } from './guacToken';

const TEST_KEY = 'MySuperSecretKeyForParamsToken12'; // 32 bytes

/**
 * A reference decrypt implementation matching guacamole-lite's real
 * lib/Crypt.js algorithm exactly (base64-unwrap outer JSON, base64-decode
 * iv and value, binary/latin1 intermediate decoding) — written here rather
 * than imported from the package's internal (non-public-API) file path, so
 * this test doesn't depend on guacamole-lite's internal file layout
 * staying stable across versions. The algorithm itself was verified
 * against the real installed 1.2.0 package directly before being encoded
 * here — see the comment in guacToken.ts for how.
 */
function referenceDecrypt(token: string): any {
  const outer = JSON.parse(Buffer.from(token, 'base64').toString('ascii'));
  const iv = Buffer.from(outer.iv, 'base64').toString('ascii');
  const value = Buffer.from(outer.value, 'base64').toString('binary');

  // SHA-256 of the raw key, not a naive Buffer.from(...).subarray(0, 32) —
  // matching encryptGuacToken's real, current behavior (see
  // guacTokenKey.ts's own comment for why this changed: guacamole-lite's
  // real Crypt class does zero transformation of whatever key it's given,
  // so truncation-based derivation silently produced a different key than
  // what guacamole-lite would actually use whenever the raw env var
  // wasn't exactly 32 bytes — a real bug found via a live deployment).
  // TEST_KEY happens to already be exactly 32 bytes, which is exactly the
  // case where the old and new derivations diverge the most (truncation
  // is a no-op on an already-32-byte input; hashing never is).
  const key = crypto.createHash('sha256').update(TEST_KEY).digest();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'ascii'));
  let decrypted = decipher.update(value, 'binary', 'ascii');
  decrypted += decipher.final('ascii');
  return JSON.parse(decrypted);
}

describe('encryptGuacToken', () => {
  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env.GUAC_TOKEN_ENCRYPTION_KEY;
    process.env.GUAC_TOKEN_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey !== undefined) process.env.GUAC_TOKEN_ENCRYPTION_KEY = originalKey;
    else delete process.env.GUAC_TOKEN_ENCRYPTION_KEY;
  });

  it('produces a token that decrypts correctly with the reference algorithm', () => {
    const payload = { userId: 'user-1', connectionId: 'conn-1' };
    const token = encryptGuacToken(payload);
    expect(referenceDecrypt(token)).toEqual(payload);
  });

  it('round-trips a payload with nested objects (a real connection settings shape)', () => {
    const payload = {
      userId: 'user-1',
      connection: {
        type: 'rdp',
        settings: { hostname: '10.0.0.5', port: 3389, username: 'admin', password: 'hunter2', 'enable-drive': true }
      }
    };
    const token = encryptGuacToken(payload);
    expect(referenceDecrypt(token)).toEqual(payload);
  });

  it('produces a different ciphertext each time (random IV), even for the same payload', () => {
    const payload = { userId: 'user-1' };
    const tokenA = encryptGuacToken(payload);
    const tokenB = encryptGuacToken(payload);
    expect(tokenA).not.toBe(tokenB);
    expect(referenceDecrypt(tokenA)).toEqual(payload);
    expect(referenceDecrypt(tokenB)).toEqual(payload);
  });

  it('the outer token is valid base64 wrapping a JSON object with iv and value fields', () => {
    const token = encryptGuacToken({ a: 1 });
    const outer = JSON.parse(Buffer.from(token, 'base64').toString('ascii'));
    expect(outer).toHaveProperty('iv');
    expect(outer).toHaveProperty('value');
  });
});
