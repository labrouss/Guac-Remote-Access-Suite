import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { issueSessionToken, hasExceededAbsoluteMax, SESSION_IDLE_TIMEOUT_MINUTES, SESSION_ABSOLUTE_MAX_HOURS } from './sessionToken';

describe('sessionToken', () => {
  describe('issueSessionToken', () => {
    it('issues a token with stage "authenticated" and the given userId as sub', () => {
      const token = issueSessionToken('user-123');
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      expect(decoded.sub).toBe('user-123');
      expect(decoded.stage).toBe('authenticated');
    });

    it('defaults loginAt to now when not given (a fresh login)', () => {
      const before = Math.floor(Date.now() / 1000);
      const token = issueSessionToken('user-123');
      const after = Math.floor(Date.now() / 1000);
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      expect(decoded.loginAt).toBeGreaterThanOrEqual(before);
      expect(decoded.loginAt).toBeLessThanOrEqual(after);
    });

    it('carries a given loginAt through unchanged — a refresh of an existing session, not a fresh login', () => {
      const originalLoginAt = Math.floor(Date.now() / 1000) - 3600; // an hour ago
      const token = issueSessionToken('user-123', originalLoginAt);
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      expect(decoded.loginAt).toBe(originalLoginAt);
    });

    it('sets the token\'s own expiry to SESSION_IDLE_TIMEOUT_MINUTES from now, not the absolute-max hours', () => {
      const token = issueSessionToken('user-123');
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      const expectedExp = decoded.iat + SESSION_IDLE_TIMEOUT_MINUTES * 60;
      expect(decoded.exp).toBe(expectedExp);
    });
  });

  describe('hasExceededAbsoluteMax', () => {
    it('is false for a session that just logged in', () => {
      const loginAt = Math.floor(Date.now() / 1000);
      expect(hasExceededAbsoluteMax(loginAt)).toBe(false);
    });

    it('is false just under the absolute max', () => {
      const loginAt = Math.floor(Date.now() / 1000) - (SESSION_ABSOLUTE_MAX_HOURS * 60 * 60 - 60);
      expect(hasExceededAbsoluteMax(loginAt)).toBe(false);
    });

    it('is true just over the absolute max, even though the session could otherwise still be actively refreshing', () => {
      const loginAt = Math.floor(Date.now() / 1000) - (SESSION_ABSOLUTE_MAX_HOURS * 60 * 60 + 60);
      expect(hasExceededAbsoluteMax(loginAt)).toBe(true);
    });
  });
});
