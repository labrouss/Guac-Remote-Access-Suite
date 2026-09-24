import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ one: vi.fn(), oneOrNone: vi.fn(), none: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const provisionPersonalListMock = vi.hoisted(() => vi.fn());
vi.mock('../services/userProvisioning', () => ({ provisionPersonalList: provisionPersonalListMock }));

vi.mock('../services/vaultClient', () => ({ checkVaultHealth: vi.fn() }));
vi.mock('../services/totp', () => ({ generateTotpEnrollment: vi.fn(), verifyTotpCode: vi.fn() }));
vi.mock('../services/auditLog', () => ({ logAudit: vi.fn() }));
vi.mock('../services/csrf', () => ({ issueCsrfToken: vi.fn(), requireCsrfToken: vi.fn() }));

import { setupAdmin } from './setup';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setupAdmin', () => {
  it('returns already_completed and does nothing else if setup is already done', async () => {
    dbMock.one.mockResolvedValueOnce({ setup_completed: true });

    const result = await setupAdmin('admin', 'a valid long password', 'Instance');

    expect(result).toEqual({ status: 'already_completed' });
    expect(dbMock.oneOrNone).not.toHaveBeenCalled();
  });

  it('rejects a password under 12 characters, before touching the database for a user lookup', async () => {
    dbMock.one.mockResolvedValueOnce({ setup_completed: false });

    const result = await setupAdmin('admin', 'short', 'Instance');

    expect(result.status).toBe('invalid_input');
    expect(dbMock.oneOrNone).not.toHaveBeenCalled();
  });

  describe('no existing user with this username', () => {
    beforeEach(() => {
      dbMock.one.mockResolvedValueOnce({ setup_completed: false }); // status check
      dbMock.oneOrNone.mockResolvedValueOnce(null); // no existing user
      dbMock.one.mockResolvedValueOnce({ id: 'new-user-id' }); // INSERT ... RETURNING id
      dbMock.oneOrNone.mockResolvedValueOnce(null); // no existing personal list
    });

    it('creates a brand-new user and returns ok', async () => {
      const result = await setupAdmin('admin', 'a valid long password', 'Instance');
      expect(result).toEqual({ status: 'ok', userId: 'new-user-id' });
    });

    it('provisions a personal list for the new user', async () => {
      await setupAdmin('admin', 'a valid long password', 'Instance');
      expect(provisionPersonalListMock).toHaveBeenCalledWith('new-user-id');
    });

    it('adds the new user to Administrators', async () => {
      await setupAdmin('admin', 'a valid long password', 'Instance');
      const groupInsertCall = dbMock.none.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_groups'));
      expect(groupInsertCall![1]).toEqual(['new-user-id']);
    });
  });

  describe('resuming an interrupted setup (existing user, setup still incomplete)', () => {
    beforeEach(() => {
      dbMock.one.mockResolvedValueOnce({ setup_completed: false }); // status check
      dbMock.oneOrNone.mockResolvedValueOnce({ id: 'existing-user-id' }); // existing user found
    });

    it("updates the existing user's password rather than trying to INSERT a duplicate", async () => {
      dbMock.oneOrNone.mockResolvedValueOnce({ id: 'existing-personal-list-id' }); // already has a personal list

      const result = await setupAdmin('admin', 'a new valid password', 'Instance');

      expect(result).toEqual({ status: 'ok', userId: 'existing-user-id' });
      const updateCall = dbMock.none.mock.calls.find(([sql]) => sql.includes('UPDATE users SET password_hash'));
      expect(updateCall![1][1]).toBe('existing-user-id');
    });

    it('does NOT call provisionPersonalList again if a personal list already exists — that function is not itself safe to call twice', async () => {
      dbMock.oneOrNone.mockResolvedValueOnce({ id: 'existing-personal-list-id' });

      await setupAdmin('admin', 'a new valid password', 'Instance');

      expect(provisionPersonalListMock).not.toHaveBeenCalled();
    });

    it('DOES provision a personal list if the earlier interrupted attempt never got that far', async () => {
      dbMock.oneOrNone.mockResolvedValueOnce(null); // no personal list yet

      await setupAdmin('admin', 'a new valid password', 'Instance');

      expect(provisionPersonalListMock).toHaveBeenCalledWith('existing-user-id');
    });

    it('still (idempotently) ensures Administrators membership, in case the earlier attempt was interrupted before that step', async () => {
      dbMock.oneOrNone.mockResolvedValueOnce({ id: 'existing-personal-list-id' });

      await setupAdmin('admin', 'a new valid password', 'Instance');

      const groupInsertCall = dbMock.none.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_groups'));
      expect(groupInsertCall![0]).toContain('ON CONFLICT DO NOTHING');
      expect(groupInsertCall![1]).toEqual(['existing-user-id']);
    });
  });
});
