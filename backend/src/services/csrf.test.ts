import { describe, it, expect, vi } from 'vitest';
import { issueCsrfToken, requireCsrfToken } from './csrf';

function fakeReq(sessionCsrfToken?: string, headerToken?: string) {
  return {
    session: sessionCsrfToken !== undefined ? { csrfToken: sessionCsrfToken } : {},
    headers: headerToken !== undefined ? { 'x-csrf-token': headerToken } : {}
  } as any;
}

describe('issueCsrfToken', () => {
  it('generates a new token when the session has none yet', () => {
    const req = fakeReq();
    const token = issueCsrfToken(req);
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex-encoded
    expect(req.session.csrfToken).toBe(token);
  });

  it('returns the same token on a second call within the same session, not a new one', () => {
    const req = fakeReq();
    const first = issueCsrfToken(req);
    const second = issueCsrfToken(req);
    expect(second).toBe(first);
  });

  it('generates different tokens across two independent sessions', () => {
    const tokenA = issueCsrfToken(fakeReq());
    const tokenB = issueCsrfToken(fakeReq());
    expect(tokenA).not.toBe(tokenB);
  });
});

describe('requireCsrfToken', () => {
  it('rejects when the session has no token issued at all', () => {
    const req = fakeReq(undefined, 'some-header-value');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    requireCsrfToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects when the header is missing entirely', () => {
    const req = fakeReq('session-token-abc');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    requireCsrfToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects when the header value does not match the session token', () => {
    const req = fakeReq('session-token-abc', 'a-different-value');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    requireCsrfToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the header exactly matches the session token', () => {
    const req = fakeReq('session-token-abc', 'session-token-abc');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    requireCsrfToken(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('does not accidentally succeed via case-insensitive or partial matching', () => {
    const req = fakeReq('AbCdEf123456', 'abcdef123456');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    requireCsrfToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
