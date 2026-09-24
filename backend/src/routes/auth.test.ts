import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const dbMock = vi.hoisted(() => ({ one: vi.fn(), oneOrNone: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const auditMock = vi.hoisted(() => ({ logAudit: vi.fn() }));
vi.mock('../services/auditLog', () => auditMock);

const waMock = vi.hoisted(() => ({
  generatePasskeyAuthenticationOptions: vi.fn(),
  verifyPasskeyAuthentication: vi.fn()
}));
vi.mock('../services/webauthn', () => waMock);

const adMock = vi.hoisted(() => ({
  isAdEnabled: vi.fn(() => false),
  authenticateAgainstAd: vi.fn(),
  findOrProvisionAdUser: vi.fn(),
  storeAdPassthroughCredential: vi.fn(),
}));
vi.mock('../services/activeDirectory', () => adMock);

// A pass-through no-op, not the real rate limiter: express-rate-limit's
// default store keys by req.ip, and every supertest request in this file
// shares the same loopback address — real rate limiting here would mean
// this file's own growing number of /login-hitting tests eventually
// start 429ing each other, which is what actually happened once the AD
// tests below were added (five separate test failures, all really the
// same root cause). Rate-limiting behavior itself has no dedicated test
// of its own in this file either way — these tests are about
// authentication logic, not the limiter sitting in front of it.
vi.mock('express-rate-limit', () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { authRouter } from './auth';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/auth/passkey/options', () => {
  it('returns the generated options alongside a short-lived auth token carrying the challenge', async () => {
    waMock.generatePasskeyAuthenticationOptions.mockResolvedValue({ challenge: 'the-challenge', rpId: 'example.com' });

    const res = await request(buildApp()).post('/api/auth/passkey/options').send({});

    expect(res.status).toBe(200);
    expect(res.body.options).toEqual({ challenge: 'the-challenge', rpId: 'example.com' });
    const decoded = jwt.verify(res.body.authToken, process.env.JWT_SECRET!) as any;
    expect(decoded.challenge).toBe('the-challenge');
    expect(decoded.stage).toBe('webauthn_authentication_pending');
  });
});

describe('POST /api/auth/passkey/verify', () => {
  function signAuthToken(overrides: Partial<{ challenge: string; stage: string }> = {}, expiresIn = '60s') {
    return jwt.sign(
      { challenge: 'the-challenge', stage: 'webauthn_authentication_pending', ...overrides },
      process.env.JWT_SECRET!,
      { expiresIn }
    );
  }

  it('rejects a missing or garbage authToken outright, before ever calling into the verification service', async () => {
    const res = await request(buildApp()).post('/api/auth/passkey/verify').send({ authToken: 'not-a-real-jwt', response: {} });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_or_expired_auth_token');
    expect(waMock.verifyPasskeyAuthentication).not.toHaveBeenCalled();
  });

  it('rejects a genuinely expired auth token (real expiry, actually waited out)', async () => {
    const expired = signAuthToken({}, '1ms');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await request(buildApp()).post('/api/auth/passkey/verify').send({ authToken: expired, response: {} });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_or_expired_auth_token');
  });

  it('rejects a token with the wrong stage — e.g. a totp_pending token from the password login flow', async () => {
    const wrongStage = jwt.sign({ challenge: 'x', stage: 'totp_pending' }, process.env.JWT_SECRET!, { expiresIn: '60s' });

    const res = await request(buildApp()).post('/api/auth/passkey/verify').send({ authToken: wrongStage, response: {} });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_auth_token');
    expect(waMock.verifyPasskeyAuthentication).not.toHaveBeenCalled();
  });

  it('passes the challenge recovered from the token through to the verification service unchanged', async () => {
    waMock.verifyPasskeyAuthentication.mockResolvedValue({ ok: false });
    const token = signAuthToken({ challenge: 'a-specific-challenge-value' });

    await request(buildApp()).post('/api/auth/passkey/verify').send({ authToken: token, response: { id: 'cred-1' } });

    expect(waMock.verifyPasskeyAuthentication).toHaveBeenCalledWith('a-specific-challenge-value', { id: 'cred-1' });
  });

  it('returns invalid_credentials, not a 500 or a leaked detail, when the verification service reports failure', async () => {
    waMock.verifyPasskeyAuthentication.mockResolvedValue({ ok: false });

    const res = await request(buildApp()).post('/api/auth/passkey/verify').send({ authToken: signAuthToken(), response: {} });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('rejects a disabled account even with a valid passkey — the same guard the password login path has', async () => {
    waMock.verifyPasskeyAuthentication.mockResolvedValue({ ok: true, userId: 'user-1' });
    dbMock.one.mockResolvedValue({ must_change_password: false, disabled_at: '2026-01-01T00:00:00Z' });

    const res = await request(buildApp()).post('/api/auth/passkey/verify').send({ authToken: signAuthToken(), response: {} });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('on success, issues a real session token directly — no separate TOTP step, since a passkey is already multi-factor on its own', async () => {
    waMock.verifyPasskeyAuthentication.mockResolvedValue({ ok: true, userId: 'user-1' });
    dbMock.one.mockResolvedValue({ must_change_password: false, disabled_at: null });

    const res = await request(buildApp()).post('/api/auth/passkey/verify').send({ authToken: signAuthToken(), response: {} });

    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(false);
    const decoded = jwt.verify(res.body.sessionToken, process.env.JWT_SECRET!) as any;
    expect(decoded.sub).toBe('user-1');
    expect(decoded.stage).toBe('authenticated');
  });
});

describe('POST /api/auth/login — AD path', () => {
  beforeEach(() => {
    adMock.isAdEnabled.mockReturnValue(false);
  });

  it('when AD is disabled, an unknown username behaves exactly as before — never touches the AD service at all', async () => {
    dbMock.oneOrNone.mockResolvedValue(null);

    const res = await request(buildApp()).post('/api/auth/login').send({ username: 'newad', password: 'whatever' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
    expect(adMock.authenticateAgainstAd).not.toHaveBeenCalled();
  });

  it('an existing local account never falls through to AD, even when AD is enabled and the local password is wrong', async () => {
    adMock.isAdEnabled.mockReturnValue(true);
    dbMock.oneOrNone.mockResolvedValue({
      id: 'local-user-1', auth_source: 'local',
      password_hash: '$argon2id$v=19$m=65536,t=3,p=4$36LG0ioXENd7beSudQsYng$Fbnkxa8oITKfpsnkSjf7tvVk29YkjkVszciXrL/Ghog',
      totp_enabled: false, disabled_at: null, must_change_password: false,
    });

    const res = await request(buildApp()).post('/api/auth/login').send({ username: 'alice', password: 'definitely-wrong' });

    expect(res.status).toBe(401);
    expect(adMock.authenticateAgainstAd).not.toHaveBeenCalled();
  });

  it('a brand-new username, with AD enabled, is JIT-provisioned on a successful AD login', async () => {
    adMock.isAdEnabled.mockReturnValue(true);
    dbMock.oneOrNone.mockResolvedValue(null); // no local row at all
    adMock.authenticateAgainstAd.mockResolvedValue({ ok: true, dn: 'cn=alice,dc=example,dc=com', resolvedUsername: 'alice' });
    adMock.findOrProvisionAdUser.mockResolvedValue({ id: 'ad-user-1', totpEnabled: false, mustChangePassword: false });

    const res = await request(buildApp()).post('/api/auth/login').send({ username: 'alice', password: 'alices-ad-password' });

    expect(res.status).toBe(200);
    expect(res.body.requiresTotp).toBe(false);
    expect(adMock.findOrProvisionAdUser).toHaveBeenCalledWith('alice');
    expect(adMock.storeAdPassthroughCredential).toHaveBeenCalledWith('ad-user-1', 'alice', 'alices-ad-password');
    const decoded = jwt.verify(res.body.sessionToken, process.env.JWT_SECRET!) as any;
    expect(decoded.sub).toBe('ad-user-1');
    expect(auditMock.logAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'ad-user-1', action: 'login_success', detail: { method: 'ad' } }));
  });

  it('a failed AD authentication (wrong password, not in required group, etc.) is rejected the same generic way as a wrong local password — but the real reason is still captured in the audit log for an admin to find', async () => {
    adMock.isAdEnabled.mockReturnValue(true);
    dbMock.oneOrNone.mockResolvedValue(null);
    adMock.authenticateAgainstAd.mockResolvedValue({ ok: false, reason: 'not_in_required_group' });

    const res = await request(buildApp()).post('/api/auth/login').send({ username: 'bob', password: 'bobs-password' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
    expect(adMock.findOrProvisionAdUser).not.toHaveBeenCalled();
    // The real point of this test: adResult.reason used to be computed
    // and then silently discarded — never recorded anywhere at all, so
    // an admin looking at the audit log afterward couldn't tell "wrong
    // password" from "not in the required group" from "AD unreachable."
    // The response to the browser stays generic (asserted above); only
    // the admin-only audit log gets the specific reason.
    expect(auditMock.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'login_failed',
      detail: { username: 'bob', reason: 'not_in_required_group' },
    }));
  });

  it('a previously-provisioned AD account this app has locally disabled is rejected without even attempting the AD bind', async () => {
    adMock.isAdEnabled.mockReturnValue(true);
    dbMock.oneOrNone.mockResolvedValue({
      id: 'ad-user-1', auth_source: 'ad',
      password_hash: null, totp_enabled: false, disabled_at: '2026-01-01T00:00:00Z', must_change_password: false,
    });

    const res = await request(buildApp()).post('/api/auth/login').send({ username: 'alice', password: 'alices-ad-password' });

    expect(res.status).toBe(401);
    // The real, important assertion: this app's own disable takes effect
    // before ever asking AD anything, not after.
    expect(adMock.authenticateAgainstAd).not.toHaveBeenCalled();
  });

  it('a repeat login for an already-provisioned AD account re-authenticates against AD again, not just trusting the local row', async () => {
    adMock.isAdEnabled.mockReturnValue(true);
    dbMock.oneOrNone.mockResolvedValue({
      id: 'ad-user-1', auth_source: 'ad',
      password_hash: null, totp_enabled: true, disabled_at: null, must_change_password: false,
    });
    adMock.authenticateAgainstAd.mockResolvedValue({ ok: true, dn: 'cn=alice,dc=example,dc=com', resolvedUsername: 'alice' });
    adMock.findOrProvisionAdUser.mockResolvedValue({ id: 'ad-user-1', totpEnabled: true, mustChangePassword: false });

    const res = await request(buildApp()).post('/api/auth/login').send({ username: 'alice', password: 'alices-ad-password' });

    expect(adMock.authenticateAgainstAd).toHaveBeenCalledWith('alice', 'alices-ad-password');
    // TOTP is on for this account (self-service, same as any local
    // account could enable) — a pending token, not a full session yet.
    expect(res.body.requiresTotp).toBe(true);
    expect(res.body.sessionToken).toBeUndefined();
  });
});
