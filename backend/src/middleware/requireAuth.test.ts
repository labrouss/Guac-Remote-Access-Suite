import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { requireAuth } from './requireAuth';
import { issueSessionToken, SESSION_ABSOLUTE_MAX_HOURS } from '../services/sessionToken';

function fakeRequest(authHeader?: string) {
  return { headers: { authorization: authHeader } } as any;
}

function fakeResponse() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  return res;
}

describe('requireAuth', () => {
  it('rejects a request with no Authorization header at all', () => {
    const req = fakeRequest(undefined);
    const res = fakeResponse();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'missing_token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a header that is not a Bearer token', () => {
    const req = fakeRequest('Basic somevalue');
    const res = fakeResponse();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'missing_token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token signed with the wrong secret', () => {
    const forged = jwt.sign({ sub: 'user-1', stage: 'authenticated', loginAt: Math.floor(Date.now() / 1000) }, 'wrong-secret', { expiresIn: '30m' });
    const req = fakeRequest(`Bearer ${forged}`);
    const res = fakeResponse();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid_or_expired_token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a genuinely expired token (real jwt expiry, not mocked)', async () => {
    // expiresIn: '1ms' — signed, then actually waited out, so this is jwt's
    // own real expiry check firing, not a simulated/mocked clock.
    const expired = jwt.sign(
      { sub: 'user-1', stage: 'authenticated', loginAt: Math.floor(Date.now() / 1000) },
      process.env.JWT_SECRET!,
      { expiresIn: '1ms' }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const req = fakeRequest(`Bearer ${expired}`);
    const res = fakeResponse();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid_or_expired_token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a pending (pre-2FA) token — stage is not "authenticated"', () => {
    const pending = jwt.sign({ sub: 'user-1', stage: 'totp_pending' }, process.env.JWT_SECRET!, { expiresIn: '5m' });
    const req = fakeRequest(`Bearer ${pending}`);
    const res = fakeResponse();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'incomplete_login' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token whose own idle-window expiry is still valid but whose original loginAt has passed the absolute max', () => {
    // The scenario the absolute-max check exists for: someone who has been
    // continuously active, so every sliding-window refresh keeps
    // succeeding — this token's own exp is comfortably in the future, and
    // only the separate loginAt-based check should catch it.
    const longAgoLogin = Math.floor(Date.now() / 1000) - (SESSION_ABSOLUTE_MAX_HOURS * 60 * 60 + 60);
    const stillActivelyRefreshed = jwt.sign(
      { sub: 'user-1', stage: 'authenticated', loginAt: longAgoLogin },
      process.env.JWT_SECRET!,
      { expiresIn: '30m' }
    );
    const req = fakeRequest(`Bearer ${stillActivelyRefreshed}`);
    const res = fakeResponse();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'session_expired' });
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a valid token, sets req.userId, and issues a refreshed token as a response header', () => {
    const loginAt = Math.floor(Date.now() / 1000) - 60; // logged in a minute ago
    const token = issueSessionToken('user-1', loginAt);
    const req = fakeRequest(`Bearer ${token}`);
    const res = fakeResponse();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.userId).toBe('user-1');

    expect(res.setHeader).toHaveBeenCalledWith('X-Refreshed-Session-Token', expect.any(String));
    const refreshedToken = res.setHeader.mock.calls[0][1];
    const decoded = jwt.verify(refreshedToken, process.env.JWT_SECRET!) as any;
    // The refreshed token carries the SAME original loginAt through, not a
    // new one — this is what makes the absolute-max check above meaningful
    // across any number of refreshes, rather than resetting on every request.
    expect(decoded.loginAt).toBe(loginAt);
    expect(decoded.sub).toBe('user-1');
    expect(decoded.stage).toBe('authenticated');
  });
});
