import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  verifyProxySessionToken,
  extractProxyCookieFromRawHeader,
  issueProxySessionCookie
} from './bookmarkProxy';

const SECRET = 'test-only-secret-do-not-use-in-real-deployments'; // matches vitest.config.ts

function signToken(payload: object, options: jwt.SignOptions = {}) {
  return jwt.sign(payload, SECRET, { expiresIn: '2h', ...options });
}

describe('verifyProxySessionToken', () => {
  it('returns the userId for a valid token matching the requested bookmarkId', () => {
    const token = signToken({ userId: 'user-1', bookmarkId: 'bm-1' });
    expect(verifyProxySessionToken(token, 'bm-1')).toBe('user-1');
  });

  it('rejects a token issued for a different bookmarkId', () => {
    // This is the specific attack the path-scoped cookie design is meant to
    // prevent: a cookie valid for one bookmark's proxy path should never
    // authorize a different bookmark, even with a structurally valid,
    // correctly-signed token.
    const token = signToken({ userId: 'user-1', bookmarkId: 'bm-1' });
    expect(verifyProxySessionToken(token, 'bm-2')).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signToken({ userId: 'user-1', bookmarkId: 'bm-1' }, { expiresIn: '-1s' });
    expect(verifyProxySessionToken(token, 'bm-1')).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign({ userId: 'user-1', bookmarkId: 'bm-1' }, 'wrong-secret', { expiresIn: '2h' });
    expect(verifyProxySessionToken(forged, 'bm-1')).toBeNull();
  });

  it('rejects a malformed token string without throwing', () => {
    expect(() => verifyProxySessionToken('not-a-real-jwt', 'bm-1')).not.toThrow();
    expect(verifyProxySessionToken('not-a-real-jwt', 'bm-1')).toBeNull();
  });

  it('rejects undefined (no cookie present at all)', () => {
    expect(verifyProxySessionToken(undefined, 'bm-1')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(verifyProxySessionToken('', 'bm-1')).toBeNull();
  });
});

describe('extractProxyCookieFromRawHeader', () => {
  it('extracts the value when it is the only cookie', () => {
    expect(extractProxyCookieFromRawHeader('guac_proxy_session=abc123')).toBe('abc123');
  });

  it('extracts the value when other cookies are present before it', () => {
    expect(extractProxyCookieFromRawHeader('theme=dark; guac_proxy_session=abc123')).toBe('abc123');
  });

  it('extracts the value when other cookies are present after it', () => {
    expect(extractProxyCookieFromRawHeader('guac_proxy_session=abc123; theme=dark')).toBe('abc123');
  });

  it('extracts the value when surrounded by other cookies on both sides', () => {
    expect(extractProxyCookieFromRawHeader('a=1; guac_proxy_session=abc123; b=2')).toBe('abc123');
  });

  it('returns undefined when the cookie is not present', () => {
    expect(extractProxyCookieFromRawHeader('theme=dark; other=value')).toBeUndefined();
  });

  it('returns undefined for an undefined header', () => {
    expect(extractProxyCookieFromRawHeader(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty header', () => {
    expect(extractProxyCookieFromRawHeader('')).toBeUndefined();
  });

  it('does not partially match a differently-named cookie that merely contains the target name as a substring', () => {
    // e.g. a hypothetical "other_guac_proxy_session=evil" cookie should not
    // be picked up as if it were the real guac_proxy_session cookie.
    expect(extractProxyCookieFromRawHeader('other_guac_proxy_session=evil')).toBeUndefined();
  });
});

// Real bug found live: `secure` was previously hardcoded to `true`
// unconditionally — correct for the recommended HTTPS-via-reverse-proxy
// deployment, but a browser will never store or send a `secure` cookie
// over plain HTTP at all, no exceptions. For a deployment genuinely
// running without TLS in front, that meant this cookie was silently,
// permanently rejected every single time, and proxied bookmarks could
// never have worked at all — reported directly as "Proxy session expired
// or missing" appearing unconditionally on every attempt, with no other
// plausible explanation once the deployment turned out to be plain HTTP.
describe('issueProxySessionCookie', () => {
  function fakeReqRes(secure: boolean) {
    const req = { secure } as any;
    const cookieCalls: any[] = [];
    const res = { cookie: vi.fn((...args) => cookieCalls.push(args)) } as any;
    return { req, res, cookieCalls };
  }

  it('sets secure: true when the request itself arrived over HTTPS', () => {
    const { req, res, cookieCalls } = fakeReqRes(true);
    issueProxySessionCookie(req, res, 'bm-1', 'user-1');
    expect(cookieCalls[0][2].secure).toBe(true);
  });

  it('sets secure: false when the request arrived over plain HTTP — the actual fix', () => {
    const { req, res, cookieCalls } = fakeReqRes(false);
    issueProxySessionCookie(req, res, 'bm-1', 'user-1');
    expect(cookieCalls[0][2].secure).toBe(false);
  });

  it('still issues a token that verifies correctly for the right bookmark, regardless of the secure flag', () => {
    const { req, res, cookieCalls } = fakeReqRes(false);
    issueProxySessionCookie(req, res, 'bm-1', 'user-42');
    const token = cookieCalls[0][1];
    expect(verifyProxySessionToken(token, 'bm-1')).toBe('user-42');
  });

  it('always sets httpOnly, regardless of the connection scheme — a plain-HTTP deployment still deserves this protection', () => {
    const { req, res, cookieCalls } = fakeReqRes(false);
    issueProxySessionCookie(req, res, 'bm-1', 'user-1');
    expect(cookieCalls[0][2].httpOnly).toBe(true);
  });
});
