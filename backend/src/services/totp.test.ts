import { describe, it, expect, vi } from 'vitest';
import { authenticator } from 'otplib';

// generateTotpEnrollment/verifyTotpCode call encryptCredential/
// decryptCredential internally, which make real HTTP requests to Vault —
// already covered separately and thoroughly in vaultClient.test.ts. Here,
// mocked as a simple reversible transform (not a pass-through — genuinely
// round-tripping the value through an encode/decode step) so this file
// can focus on what's actually new: whether the TOTP enrollment and
// verification logic these new routes depend on (POST /me/totp/enroll,
// POST /me/totp/verify) actually works end to end with a real,
// currently-valid code, not just that the right functions get called.
vi.mock('./vaultClient', () => ({
  encryptCredential: vi.fn(async (plaintext: string) => `encrypted:${Buffer.from(plaintext).toString('base64')}`),
  decryptCredential: vi.fn(async (ciphertext: string) => Buffer.from(ciphertext.replace('encrypted:', ''), 'base64').toString())
}));

import { generateTotpEnrollment, verifyTotpCode } from './totp';

describe('generateTotpEnrollment', () => {
  it('returns an otpauth:// URL containing the username and instance name', async () => {
    const { otpauthUrl } = await generateTotpEnrollment('alice', 'Guac Access Suite');
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(decodeURIComponent(otpauthUrl)).toContain('alice');
    expect(decodeURIComponent(otpauthUrl)).toContain('Guac Access Suite');
  });

  it('returns the secret only in its encrypted form, never in the plain otpauth URL response shape', async () => {
    const { secretEncrypted } = await generateTotpEnrollment('alice', 'Guac Access Suite');
    expect(secretEncrypted).toMatch(/^encrypted:/);
  });
});

describe('verifyTotpCode — the actual round trip these new routes depend on', () => {
  it('accepts a real, currently-valid code generated for the enrolled secret', async () => {
    const { secretEncrypted } = await generateTotpEnrollment('alice', 'Guac Access Suite');

    // Recover the raw secret the same way verifyTotpCode itself will
    // (via the mocked decryptCredential above) to generate a real,
    // currently-valid 6-digit code — not a hardcoded one, since TOTP
    // codes are time-based and any fixed string would be a coin flip
    // depending on when the test happens to run.
    const rawSecret = Buffer.from(secretEncrypted.replace('encrypted:', ''), 'base64').toString();
    const validCode = authenticator.generate(rawSecret);

    await expect(verifyTotpCode(secretEncrypted, validCode)).resolves.toBe(true);
  });

  it('rejects an incorrect code', async () => {
    const { secretEncrypted } = await generateTotpEnrollment('alice', 'Guac Access Suite');
    await expect(verifyTotpCode(secretEncrypted, '000000')).resolves.toBe(false);
  });

  it("rejects a code generated for a different user's secret — confirms this isn't accepting any well-formed code", async () => {
    const enrollmentA = await generateTotpEnrollment('alice', 'Guac Access Suite');
    const enrollmentB = await generateTotpEnrollment('bob', 'Guac Access Suite');

    const rawSecretB = Buffer.from(enrollmentB.secretEncrypted.replace('encrypted:', ''), 'base64').toString();
    const codeForB = authenticator.generate(rawSecretB);

    // A code valid for bob's secret must not verify against alice's.
    await expect(verifyTotpCode(enrollmentA.secretEncrypted, codeForB)).resolves.toBe(false);
  });
});
