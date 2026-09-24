import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  one: vi.fn(),
  oneOrNone: vi.fn(),
  any: vi.fn(),
  none: vi.fn()
}));
vi.mock('../db', () => ({ db: dbMock }));

const getEffectiveListPermissionMock = vi.hoisted(() => vi.fn());
const isAdministratorMock = vi.hoisted(() => vi.fn());
vi.mock('../services/permissions', () => ({
  getEffectiveListPermission: getEffectiveListPermissionMock,
  isAdministrator: isAdministratorMock,
}));

import { isOwner, getResolvedDemoView, addDemoItem, searchDemoItems } from './demos';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isOwner', () => {
  it('is true when a matching demo/owner row exists', async () => {
    dbMock.oneOrNone.mockResolvedValue({ '?column?': 1 });
    expect(await isOwner('demo-1', 'user-1')).toBe(true);
  });

  it('is false when no matching row is found (wrong owner or missing demo)', async () => {
    dbMock.oneOrNone.mockResolvedValue(null);
    expect(await isOwner('demo-1', 'user-2')).toBe(false);
  });
});

describe('getResolvedDemoView', () => {
  it('returns not_found for a nonexistent demo', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(null); // demo lookup

    const view = await getResolvedDemoView('missing-demo', 'user-1');
    expect(view).toEqual({ status: 'not_found' });
  });

  it('the owner always sees the demo, with no grant lookup performed at all', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ id: 'demo-1', slug: 'veeamdemo', title: 'Veeam', description: '', owner_id: 'user-1' });
    dbMock.any.mockResolvedValueOnce([]); // demo_items

    const view = await getResolvedDemoView('demo-1', 'user-1');

    expect(view.status).toBe('ok');
    if (view.status === 'ok') expect(view.isOwner).toBe(true);
    // Ownership alone should short-circuit the grant check — the owner
    // lookup was the only oneOrNone call made.
    expect(dbMock.oneOrNone).toHaveBeenCalledTimes(1);
  });

  it('a non-owner with a valid (non-expired) grant is authorized', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ id: 'demo-1', slug: 'veeamdemo', title: 'Veeam', description: '', owner_id: 'owner-user' })
      .mockResolvedValueOnce({ '?column?': 1 }); // demo_access grant found
    dbMock.any.mockResolvedValueOnce([]);

    const view = await getResolvedDemoView('demo-1', 'viewer-user');

    expect(view.status).toBe('ok');
    if (view.status === 'ok') expect(view.isOwner).toBe(false);
  });

  it('a non-owner with no grant at all is rejected as not_authorized', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ id: 'demo-1', slug: 'veeamdemo', title: 'Veeam', description: '', owner_id: 'owner-user' })
      .mockResolvedValueOnce(null); // no demo_access row

    const view = await getResolvedDemoView('demo-1', 'stranger-user');
    expect(view).toEqual({ status: 'not_authorized' });
  });

  it('the expiry check itself is delegated to SQL (now() comparison), not re-checked in JS', async () => {
    // Pins the query shape: if the expiry clause were ever dropped from the
    // SQL, this mock would still resolve truthy for an actually-expired
    // grant — an integration test against real Postgres (see
    // docs/TESTING_PLAN.md's Layer 2 section) is what would catch that
    // class of regression end to end. Here we at least confirm the query
    // text still contains the expiry condition.
    dbMock.oneOrNone
      .mockResolvedValueOnce({ id: 'demo-1', slug: 'x', title: 'x', description: '', owner_id: 'owner-user' })
      .mockResolvedValueOnce(null);

    await getResolvedDemoView('demo-1', 'viewer-user');

    const [sql] = dbMock.oneOrNone.mock.calls[1];
    expect(sql).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);
  });

  it('resolves connection and bookmark items into a single ordered items array', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ id: 'demo-1', slug: 'x', title: 'x', description: '', owner_id: 'user-1' });
    dbMock.any
      .mockResolvedValueOnce([
        { id: 'item-1', item_type: 'connection', item_id: 'conn-1', sort_order: 0 },
        { id: 'item-2', item_type: 'bookmark', item_id: 'bm-1', sort_order: 1 }
      ])
      .mockResolvedValueOnce([
        { id: 'conn-1', name: 'Veeam Server', protocol: 'rdp', hostname: 'h', port: 3389, credential_mode: 'shared' }
      ])
      .mockResolvedValueOnce([
        { id: 'bm-1', name: 'Veeam Docs', url: 'https://example.com', description: '', access_mode: 'direct', enable_websocket: false }
      ]);

    const view = await getResolvedDemoView('demo-1', 'user-1');

    expect(view.status).toBe('ok');
    if (view.status === 'ok') {
      expect(view.items).toHaveLength(2);
      expect(view.items[0]).toMatchObject({ id: 'conn-1', itemType: 'connection' });
      expect(view.items[1]).toMatchObject({ id: 'bm-1', itemType: 'bookmark' });
    }
  });

  it('silently drops an item whose underlying connection/bookmark was since deleted, rather than erroring', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ id: 'demo-1', slug: 'x', title: 'x', description: '', owner_id: 'user-1' });
    dbMock.any
      .mockResolvedValueOnce([{ id: 'item-1', item_type: 'connection', item_id: 'deleted-conn', sort_order: 0 }])
      .mockResolvedValueOnce([]); // connections query returns nothing — it was deleted

    const view = await getResolvedDemoView('demo-1', 'user-1');

    expect(view.status).toBe('ok');
    if (view.status === 'ok') expect(view.items).toHaveLength(0);
  });

  it('does not query connections/bookmarks tables at all when the demo has zero items', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ id: 'demo-1', slug: 'x', title: 'x', description: '', owner_id: 'user-1' });
    dbMock.any.mockResolvedValueOnce([]); // demo_items empty

    await getResolvedDemoView('demo-1', 'user-1');

    // Only the demo_items query should have run — no follow-up IN (...)
    // queries against empty id arrays.
    expect(dbMock.any).toHaveBeenCalledTimes(1);
  });
});

describe('addDemoItem', () => {
  it('rejects when the caller is not the demo owner, before checking anything else', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(null); // isOwner check fails

    const result = await addDemoItem('demo-1', 'not-owner', 'connection', 'conn-1', 0);

    expect(result).toEqual({ status: 'not_authorized' });
    expect(getEffectiveListPermissionMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid item type', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ '?column?': 1 }); // isOwner passes

    const result = await addDemoItem('demo-1', 'owner', 'not-a-real-type', 'x', 0);
    expect(result).toEqual({ status: 'invalid_item_type' });
  });

  it('rejects when the referenced connection/bookmark does not exist', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ '?column?': 1 }) // isOwner
      .mockResolvedValueOnce(null); // source lookup: not found

    const result = await addDemoItem('demo-1', 'owner', 'connection', 'missing-conn', 0);
    expect(result).toEqual({ status: 'item_not_found' });
  });

  it("rejects when the owner has no access to the item's own source list", async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ '?column?': 1 }) // isOwner
      .mockResolvedValueOnce({ list_id: 'list-1' }); // source found
    getEffectiveListPermissionMock.mockResolvedValueOnce(null); // no permission at all

    const result = await addDemoItem('demo-1', 'owner', 'connection', 'conn-1', 0);

    expect(result).toEqual({ status: 'no_access_to_source_item' });
    expect(dbMock.none).not.toHaveBeenCalled();
  });

  it('adds the item once ownership, item type, existence, and source access all check out', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ '?column?': 1 })
      .mockResolvedValueOnce({ list_id: 'list-1' });
    getEffectiveListPermissionMock.mockResolvedValueOnce('view');

    const result = await addDemoItem('demo-1', 'owner', 'connection', 'conn-1', 2);

    expect(result).toEqual({ status: 'added' });
    const [, args] = dbMock.none.mock.calls[0];
    expect(args).toEqual(['demo-1', 'connection', 'conn-1', 2]);
  });

  it("only requires the owner's own 'view' permission on the source, not 'connect' or higher", async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ '?column?': 1 })
      .mockResolvedValueOnce({ list_id: 'list-1' });
    getEffectiveListPermissionMock.mockResolvedValueOnce('view');

    const result = await addDemoItem('demo-1', 'owner', 'bookmark', 'bm-1', 0);
    expect(result.status).toBe('added');
  });
});

describe('searchDemoItems', () => {
  it('returns nothing at all for a query under 2 characters, without touching the database', async () => {
    const result = await searchDemoItems('user-1', 'a');
    expect(result).toEqual([]);
    expect(dbMock.any).not.toHaveBeenCalled();
    expect(isAdministratorMock).not.toHaveBeenCalled();
  });

  it('for an ordinary (non-admin) user, scopes the search by SQL-level list_id filtering, not a plain unfiltered search', async () => {
    isAdministratorMock.mockResolvedValue(false);
    dbMock.any.mockResolvedValue([{ id: 'c1', name: 'Veeam Server', item_type: 'connection', protocol: 'rdp' }]);

    const results = await searchDemoItems('user-1', 'veeam');

    expect(isAdministratorMock).toHaveBeenCalledWith('user-1');
    const [sql, params] = dbMock.any.mock.calls[0];
    expect(sql).toContain('list_user_permissions');
    expect(sql).toContain('list_group_permissions');
    expect(params).toEqual(['%veeam%', 'user-1']);
    expect(results).toEqual([{ id: 'c1', name: 'Veeam Server', item_type: 'connection', protocol: 'rdp' }]);
  });

  it('for an administrator, searches without any list_id restriction at all — matching addDemoItem\'s own admin shortcut', async () => {
    isAdministratorMock.mockResolvedValue(true);
    dbMock.any.mockResolvedValue([]);

    await searchDemoItems('admin-1', 'veeam');

    const [sql, params] = dbMock.any.mock.calls[0];
    expect(sql).not.toContain('list_user_permissions');
    expect(sql).not.toContain('list_group_permissions');
    // Only the search term itself — no user_id param needed when nothing filters by it.
    expect(params).toEqual(['%veeam%']);
  });

  it('searches both connections and bookmarks in one query, not just one or the other', async () => {
    isAdministratorMock.mockResolvedValue(true);
    dbMock.any.mockResolvedValue([]);
    await searchDemoItems('admin-1', 'veeam');
    const [sql] = dbMock.any.mock.calls[0];
    expect(sql).toContain('FROM connections');
    expect(sql).toContain('FROM bookmarks');
  });
});
