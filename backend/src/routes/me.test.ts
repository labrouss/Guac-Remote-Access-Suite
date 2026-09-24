import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const dbMock = vi.hoisted(() => ({ one: vi.fn(), none: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const auditMock = vi.hoisted(() => ({ logAuditFromRequest: vi.fn() }));
vi.mock('../services/auditLog', () => auditMock);

const totpMock = vi.hoisted(() => ({ generateTotpEnrollment: vi.fn(), verifyTotpCode: vi.fn() }));
vi.mock('../services/totp', () => totpMock);

const waMock = vi.hoisted(() => ({
  generatePasskeyRegistrationOptions: vi.fn(),
  verifyAndStorePasskeyRegistration: vi.fn(),
  listPasskeysForUser: vi.fn(),
  deletePasskey: vi.fn()
}));
vi.mock('../services/webauthn', () => waMock);

import { meRouter } from './me';

// Simulates requireAuth having already run (this app's own req.userId
// convention) — these tests are exercising me.ts's own routes, not
// requireAuth itself, which already has its own dedicated test file.
function buildApp(userId = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).userId = userId;
    next();
  });
  app.use('/api/me', meRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/me/passkeys/register-options', () => {
  it('binds the returned registrationToken to the current req.userId', async () => {
    dbMock.one.mockResolvedValue({ username: 'alice' });
    waMock.generatePasskeyRegistrationOptions.mockResolvedValue({ challenge: 'the-challenge' });

    const res = await request(buildApp('user-1')).post('/api/me/passkeys/register-options').send({});

    expect(res.status).toBe(200);
    const decoded = jwt.verify(res.body.registrationToken, process.env.JWT_SECRET!) as any;
    expect(decoded.sub).toBe('user-1');
    expect(decoded.challenge).toBe('the-challenge');
    expect(decoded.stage).toBe('webauthn_registration_pending');
  });
});

describe('POST /api/me/passkeys/register-verify', () => {
  function signToken(overrides: Partial<{ sub: string; challenge: string; stage: string }> = {}, expiresIn = '60s') {
    return jwt.sign(
      { sub: 'user-1', challenge: 'the-challenge', stage: 'webauthn_registration_pending', ...overrides },
      process.env.JWT_SECRET!,
      { expiresIn }
    );
  }

  it('requires a non-empty name before doing anything else', async () => {
    const res = await request(buildApp()).post('/api/me/passkeys/register-verify').send({ registrationToken: signToken(), response: {}, name: '   ' });

    expect(res.status).toBe(400);
    expect(waMock.verifyAndStorePasskeyRegistration).not.toHaveBeenCalled();
  });

  it('rejects a genuinely expired registration token (real expiry, actually waited out)', async () => {
    const expired = signToken({}, '1ms');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await request(buildApp()).post('/api/me/passkeys/register-verify').send({ registrationToken: expired, response: {}, name: 'My Key' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_or_expired_registration_token');
  });

  it('rejects a token belonging to a DIFFERENT user than the one currently authenticated — the actual point of checking payload.sub against req.userId', async () => {
    const someoneElsesToken = signToken({ sub: 'a-different-user' });

    const res = await request(buildApp('user-1')).post('/api/me/passkeys/register-verify').send({ registrationToken: someoneElsesToken, response: {}, name: 'My Key' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_registration_token');
    expect(waMock.verifyAndStorePasskeyRegistration).not.toHaveBeenCalled();
  });

  it('rejects the wrong stage — e.g. an authentication (login) token submitted to the registration endpoint', async () => {
    const wrongStage = signToken({ stage: 'webauthn_authentication_pending' });

    const res = await request(buildApp()).post('/api/me/passkeys/register-verify').send({ registrationToken: wrongStage, response: {}, name: 'My Key' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_registration_token');
  });

  it('on success, passes the challenge recovered from the token and the trimmed name through to the service', async () => {
    waMock.verifyAndStorePasskeyRegistration.mockResolvedValue({ ok: true });

    const res = await request(buildApp('user-1'))
      .post('/api/me/passkeys/register-verify')
      .send({ registrationToken: signToken({ challenge: 'a-specific-challenge' }), response: { id: 'cred-1' }, name: '  My Laptop  ' });

    expect(res.status).toBe(200);
    expect(waMock.verifyAndStorePasskeyRegistration).toHaveBeenCalledWith('user-1', 'a-specific-challenge', { id: 'cred-1' }, 'My Laptop');
  });

  it('surfaces the service\'s own failure message rather than a generic one', async () => {
    waMock.verifyAndStorePasskeyRegistration.mockResolvedValue({ ok: false, message: 'Could not verify this passkey.' });

    const res = await request(buildApp()).post('/api/me/passkeys/register-verify').send({ registrationToken: signToken(), response: {}, name: 'My Key' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Could not verify this passkey.');
  });
});

describe('DELETE /api/me/passkeys/:id', () => {
  it('scopes the delete to req.userId via the service, and reports 404 (not 200) when nothing matched', async () => {
    waMock.deletePasskey.mockResolvedValue(false);

    const res = await request(buildApp('user-1')).delete('/api/me/passkeys/some-row-id');

    expect(res.status).toBe(404);
    expect(waMock.deletePasskey).toHaveBeenCalledWith('user-1', 'some-row-id');
  });

  it('logs the removed passkey id in the audit detail, not as a connectionId — that column is a real foreign key to connections(id)', async () => {
    waMock.deletePasskey.mockResolvedValue(true);

    const res = await request(buildApp('user-1')).delete('/api/me/passkeys/some-row-id');

    expect(res.status).toBe(200);
    expect(auditMock.logAuditFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      'passkey_removed',
      { passkeyId: 'some-row-id' }
    );
  });
});
