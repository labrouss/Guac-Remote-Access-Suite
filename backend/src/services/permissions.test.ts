import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above everything else in the file, so a
// plain `const dbMock = {...}` referenced inside one throws a
// "Cannot access before initialization" error — vi.hoisted() is what makes
// the object itself part of that same hoisted scope.
const dbMock = vi.hoisted(() => ({
  any: vi.fn(),
  one: vi.fn(),
  oneOrNone: vi.fn(),
  none: vi.fn(),
  tx: vi.fn()
}));
vi.mock('../db', () => ({ db: dbMock }));

import {
  getEffectiveListPermission,
  requireListPermission,
  hasDemoAccessToConnection,
  hasDemoAccessToBookmark,
  hasConnectionAccess,
  hasBookmarkAccess,
  canAccessRecording,
  isAdministrator
} from './permissions';

beforeEach(() => {
  // resetAllMocks, not clearAllMocks — clearAllMocks only wipes call
  // history, not a still-queued mockResolvedValueOnce() left over from a
  // previous test that didn't consume every value it queued (an early
  // return means a later mocked call is never actually reached). That
  // leftover would silently leak into the next test's execution. Worth
  // being deliberate about this now specifically because
  // getEffectiveListPermission gained a new internal oneOrNone call
  // (isAdministrator) below — one more call in the chain made any
  // pre-existing risk of that leakage actually surface.
  vi.resetAllMocks();
});

describe('isAdministrator', () => {
  it('is true when the user has a row in the Administrators group', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ '?column?': 1 });
    expect(await isAdministrator('user-1')).toBe(true);
  });

  it('is false when the query finds no matching row', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(null);
    expect(await isAdministrator('user-1')).toBe(false);
  });

  it("the query is actually scoped to the 'Administrators' group by name, not any group", async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(null);
    await isAdministrator('user-1');
    const [sql] = dbMock.oneOrNone.mock.calls[0];
    expect(sql).toContain("g.name = 'Administrators'");
  });
});

describe('getEffectiveListPermission', () => {
  it('returns null when the user has no rows at all', async () => {
    dbMock.oneOrNone.mockResolvedValue(null); // isAdministrator — not an admin
    dbMock.any.mockResolvedValue([]);
    expect(await getEffectiveListPermission('user-1', 'list-1')).toBeNull();
  });

  it('returns the highest permission when multiple grants exist (direct + group)', async () => {
    dbMock.oneOrNone.mockResolvedValue(null); // isAdministrator — not an admin
    dbMock.any.mockResolvedValue([{ permission: 'view' }, { permission: 'edit' }]);
    expect(await getEffectiveListPermission('user-1', 'list-1')).toBe('edit');
  });

  it('does not let a lower later row downgrade an already-higher permission', async () => {
    dbMock.oneOrNone.mockResolvedValue(null); // isAdministrator — not an admin
    dbMock.any.mockResolvedValue([{ permission: 'admin' }, { permission: 'connect' }]);
    expect(await getEffectiveListPermission('user-1', 'list-1')).toBe('admin');
  });

  // Real, pre-existing gap this round actually fixes — see this
  // function's own comment in permissions.ts for the full reasoning
  // (a genuine multi-admin deployment, not an edge case).
  it("a global admin gets 'admin' back immediately, with zero list-specific grant rows required", async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ '?column?': 1 }); // isAdministrator — IS an admin
    expect(await getEffectiveListPermission('admin-user', 'list-nobody-granted-them')).toBe('admin');
    // Confirms this is a genuine short-circuit: the list_user_permissions/
    // list_group_permissions UNION query should never even run once
    // global admin status is already confirmed.
    expect(dbMock.any).not.toHaveBeenCalled();
  });
});

describe('requireListPermission', () => {
  it('passes when the effective permission meets the minimum', async () => {
    dbMock.oneOrNone.mockResolvedValue(null); // isAdministrator — not an admin
    dbMock.any.mockResolvedValue([{ permission: 'edit' }]);
    expect(await requireListPermission('user-1', 'list-1', 'connect')).toBe(true);
  });

  it('fails when the effective permission is below the minimum', async () => {
    dbMock.oneOrNone.mockResolvedValue(null); // isAdministrator — not an admin
    dbMock.any.mockResolvedValue([{ permission: 'view' }]);
    expect(await requireListPermission('user-1', 'list-1', 'admin')).toBe(false);
  });

  it('fails outright when there is no grant', async () => {
    dbMock.oneOrNone.mockResolvedValue(null); // isAdministrator — not an admin
    dbMock.any.mockResolvedValue([]);
    expect(await requireListPermission('user-1', 'list-1', 'view')).toBe(false);
  });

  it('a global admin passes at the strictest level, even with no list-specific grant', async () => {
    dbMock.oneOrNone.mockResolvedValue({ '?column?': 1 }); // isAdministrator — IS an admin
    expect(await requireListPermission('admin-user', 'list-1', 'admin')).toBe(true);
  });
});

describe('demo access expiry', () => {
  it('hasDemoAccessToConnection is true for a non-expired grant', async () => {
    dbMock.oneOrNone.mockResolvedValue({ '?column?': 1 });
    expect(await hasDemoAccessToConnection('user-1', 'conn-1')).toBe(true);
    // Confirm the expiry condition is actually part of the query, not just
    // trusted to the mock — regressions here should show up as a query
    // that silently drops the expiry clause.
    const [sql] = dbMock.oneOrNone.mock.calls[0];
    expect(sql).toMatch(/expires_at IS NULL OR da\.expires_at > now\(\)/);
  });

  it('hasDemoAccessToConnection is false when the query finds no matching row (e.g. expired)', async () => {
    dbMock.oneOrNone.mockResolvedValue(null);
    expect(await hasDemoAccessToConnection('user-1', 'conn-1')).toBe(false);
  });

  it('hasDemoAccessToBookmark mirrors the same expiry-aware shape', async () => {
    dbMock.oneOrNone.mockResolvedValue(null);
    expect(await hasDemoAccessToBookmark('user-1', 'bm-1')).toBe(false);
    const [sql] = dbMock.oneOrNone.mock.calls[0];
    expect(sql).toContain("item_type = 'bookmark'");
  });
});

describe('combined list-permission-or-demo-grant checks', () => {
  it('hasConnectionAccess succeeds via ordinary list permission alone', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ list_id: 'list-1' }); // connection lookup
    dbMock.any.mockResolvedValueOnce([{ permission: 'connect' }]); // list permission rows
    expect(await hasConnectionAccess('user-1', 'conn-1', 'connect')).toBe(true);
  });

  it('hasConnectionAccess falls back to a demo grant when list permission is absent', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ list_id: 'list-1' }) // connection lookup
      .mockResolvedValueOnce(null) // isAdministrator check — not an admin
      .mockResolvedValueOnce({ '?column?': 1 }); // demo grant lookup
    dbMock.any.mockResolvedValueOnce([]); // no list permission rows at all
    expect(await hasConnectionAccess('user-1', 'conn-1', 'connect')).toBe(true);
  });

  it('hasConnectionAccess never lets a demo grant satisfy an edit/admin check', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ list_id: 'list-1' }) // connection lookup
      .mockResolvedValueOnce(null); // isAdministrator check — not an admin
    dbMock.any.mockResolvedValueOnce([]); // no list permission
    // Demo-grant lookup should never even be consulted for 'edit' — if it
    // were, this test's mock would need a third oneOrNone call, which
    // hasConnectionAccess must not make for minLevel > 'connect'.
    expect(await hasConnectionAccess('user-1', 'conn-1', 'edit')).toBe(false);
    expect(dbMock.oneOrNone).toHaveBeenCalledTimes(2);
  });

  it('hasConnectionAccess returns false for a nonexistent connection', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(null);
    expect(await hasConnectionAccess('user-1', 'missing-conn', 'connect')).toBe(false);
  });

  it('hasBookmarkAccess falls back to a demo grant the same way', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ list_id: 'list-1' })
      .mockResolvedValueOnce(null) // isAdministrator check — not an admin
      .mockResolvedValueOnce({ '?column?': 1 });
    dbMock.any.mockResolvedValueOnce([]);
    expect(await hasBookmarkAccess('user-1', 'bm-1', 'view')).toBe(true);
  });
});

// Policy given directly: an admin (list-level 'admin') or the recording's
// own creator, and no one else — narrower than hasConnectionAccess's
// graduated levels on purpose, since a recording can capture on-screen
// content more sensitive than a connection's own name/hostname.
describe('canAccessRecording', () => {
  it('returns false when the recording does not exist', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(null);
    expect(await canAccessRecording('user-1', 'rec-1')).toBe(false);
  });

  it("the recording's own creator is always allowed, without even checking list permission", async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ user_id: 'user-1', connection_id: 'conn-1' });

    expect(await canAccessRecording('user-1', 'rec-1')).toBe(true);
    // Confirms the short-circuit is real, not just the right eventual
    // answer for the wrong reason — the connection/permission lookup
    // (db.any, inside getEffectiveListPermission) should never even run.
    expect(dbMock.any).not.toHaveBeenCalled();
  });

  it('a non-creator with list-level admin permission is allowed', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ user_id: 'creator-user', connection_id: 'conn-1' })
      .mockResolvedValueOnce({ list_id: 'list-1' })
      .mockResolvedValueOnce(null); // isAdministrator check — not a global admin either; this is testing the list-grant path specifically
    dbMock.any.mockResolvedValueOnce([{ permission: 'admin' }]);

    expect(await canAccessRecording('other-user', 'rec-1')).toBe(true);
  });

  it('a non-creator with only edit (not admin) permission is denied', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ user_id: 'creator-user', connection_id: 'conn-1' })
      .mockResolvedValueOnce({ list_id: 'list-1' })
      .mockResolvedValueOnce(null); // isAdministrator check
    dbMock.any.mockResolvedValueOnce([{ permission: 'edit' }]);

    expect(await canAccessRecording('other-user', 'rec-1')).toBe(false);
  });

  it('a non-creator with no list permission at all is denied', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ user_id: 'creator-user', connection_id: 'conn-1' })
      .mockResolvedValueOnce({ list_id: 'list-1' })
      .mockResolvedValueOnce(null); // isAdministrator check
    dbMock.any.mockResolvedValueOnce([]);

    expect(await canAccessRecording('other-user', 'rec-1')).toBe(false);
  });

  // Real, separate case worth its own explicit test: a non-creator who
  // *is* a global admin must still be allowed, even with zero rows in
  // list_group_permissions/list_user_permissions — this is the actual
  // behavior the round-19-style fix to getEffectiveListPermission was
  // for, distinct from the ordinary list-grant path tested just above.
  it('a non-creator who is a global admin is allowed, with no list-specific grant at all', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ user_id: 'creator-user', connection_id: 'conn-1' })
      .mockResolvedValueOnce({ list_id: 'list-1' })
      .mockResolvedValueOnce({ '?column?': 1 }); // isAdministrator check — IS a global admin

    expect(await canAccessRecording('other-user', 'rec-1')).toBe(true);
    // Confirms this is a genuine short-circuit, not a coincidence — the
    // list_group_permissions/list_user_permissions lookup should never
    // even run once global admin status is already confirmed.
    expect(dbMock.any).not.toHaveBeenCalled();
  });

  // Real edge case this policy has to handle correctly: a recording
  // survives its connection being deleted (connection_id NULL, migration
  // 016's own ON DELETE SET NULL). A non-creator has no list left to be
  // an admin of at all in that case.
  it('a non-creator is denied for an orphaned recording (connection deleted)', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ user_id: 'creator-user', connection_id: null });

    expect(await canAccessRecording('other-user', 'rec-1')).toBe(false);
    expect(dbMock.any).not.toHaveBeenCalled();
  });

  // But the creator's own access must NOT disappear along with the
  // connection — this is exactly why the creator check has to come
  // first and unconditionally, not as a fallback after a failed
  // connection/list lookup.
  it("the creator is still allowed for an orphaned recording (connection deleted)", async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ user_id: 'user-1', connection_id: null });

    expect(await canAccessRecording('user-1', 'rec-1')).toBe(true);
  });
});
