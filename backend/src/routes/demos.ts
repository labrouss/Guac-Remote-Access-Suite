import { Router } from 'express';
import { db } from '../db';
import { getEffectiveListPermission, isAdministrator } from '../services/permissions';
import { logAuditFromRequest } from '../services/auditLog';

export const demosRouter = Router();

/**
 * Exported (not just a private helper) so it's directly testable — see
 * demos.test.ts. Every mutating route below gates on this first.
 */
export async function isOwner(demoId: string, userId: string): Promise<boolean> {
  const row = await db.oneOrNone(`SELECT 1 FROM demos WHERE id = $1 AND owner_id = $2`, [demoId, userId]);
  return !!row;
}

export type ResolvedDemoView =
  | { status: 'not_found' }
  | { status: 'not_authorized' }
  | {
      status: 'ok';
      id: string;
      slug: string;
      title: string;
      description: string;
      isOwner: boolean;
      items: any[];
    };

/**
 * The full logic behind GET /:id, extracted out of the Express handler
 * (same pattern as guacTunnel.ts / credentials.ts) so the owner-bypass,
 * expiry-aware grant check, and deleted-item filtering are all directly
 * unit testable. This is the richest and most security-relevant piece of
 * demos.ts: it's what decides whether a demo viewer with NO access at all
 * to the underlying connection lists still sees exactly the curated items,
 * nothing more and nothing less.
 */
export async function getResolvedDemoView(demoId: string, userId: string): Promise<ResolvedDemoView> {
  const demo = await db.oneOrNone(`SELECT id, slug, title, description, owner_id FROM demos WHERE id = $1`, [demoId]);
  if (!demo) return { status: 'not_found' };

  const isTheOwner = demo.owner_id === userId;
  const hasGrant = isTheOwner
    ? true
    : !!(await db.oneOrNone(
        `SELECT 1 FROM demo_access WHERE demo_id = $1 AND user_id = $2 AND (expires_at IS NULL OR expires_at > now())`,
        [demoId, userId]
      ));
  if (!hasGrant) return { status: 'not_authorized' };

  const items = await db.any(
    `SELECT id, item_type, item_id, sort_order FROM demo_items WHERE demo_id = $1 ORDER BY sort_order, added_at`,
    [demoId]
  );

  const connectionIds = items.filter((i: any) => i.item_type === 'connection').map((i: any) => i.item_id);
  const bookmarkIds = items.filter((i: any) => i.item_type === 'bookmark').map((i: any) => i.item_id);

  const connections = connectionIds.length
    ? await db.any(
        `SELECT id, name, protocol, hostname, port, credential_mode FROM connections WHERE id IN ($1:csv)`,
        [connectionIds]
      )
    : [];
  const bookmarks = bookmarkIds.length
    ? await db.any(
        `SELECT id, name, url, description, access_mode, enable_websocket FROM bookmarks WHERE id IN ($1:csv)`,
        [bookmarkIds]
      )
    : [];

  const resolvedItems = items
    .map((item: any) => {
      const source =
        item.item_type === 'connection'
          ? connections.find((c: any) => c.id === item.item_id)
          : bookmarks.find((b: any) => b.id === item.item_id);
      // An item referenced by demo_items may since have been deleted from
      // its original list — skip it rather than error the whole demo out.
      if (!source) return null;
      return { ...source, itemType: item.item_type, sortOrder: item.sort_order };
    })
    .filter(Boolean);

  return {
    status: 'ok',
    id: demo.id,
    slug: demo.slug,
    title: demo.title,
    description: demo.description,
    isOwner: isTheOwner,
    items: resolvedItems
  };
}

export type AddDemoItemResult =
  | { status: 'not_authorized' }
  | { status: 'invalid_item_type' }
  | { status: 'item_not_found' }
  | { status: 'no_access_to_source_item' }
  | { status: 'added' };

/**
 * The demo owner must themselves have at least 'view' on the item's parent
 * list — you can't curate a demo out of things you can't see yourself, even
 * though granting demo access won't require the viewer to have that same
 * permission. Extracted for the same reason as getResolvedDemoView above.
 */
export async function addDemoItem(
  demoId: string,
  userId: string,
  itemType: string,
  itemId: string,
  sortOrder: number
): Promise<AddDemoItemResult> {
  if (!(await isOwner(demoId, userId))) return { status: 'not_authorized' };
  if (!['connection', 'bookmark'].includes(itemType)) return { status: 'invalid_item_type' };

  const table = itemType === 'connection' ? 'connections' : 'bookmarks';
  const source = await db.oneOrNone(`SELECT list_id FROM ${table} WHERE id = $1`, [itemId]);
  if (!source) return { status: 'item_not_found' };

  const allowed = await getEffectiveListPermission(userId, source.list_id);
  if (!allowed) return { status: 'no_access_to_source_item' };

  await db.none(
    `INSERT INTO demo_items (demo_id, item_type, item_id, sort_order) VALUES ($1, $2, $3, $4)
     ON CONFLICT (demo_id, item_type, item_id) DO UPDATE SET sort_order = $4`,
    [demoId, itemType, itemId, sortOrder ?? 0]
  );
  return { status: 'added' };
}

// Requested directly — "unfinished business" left in the UI copy itself
// (demos.addItemHint used to say so plainly: "Add by connection/bookmark
// ID for now — a name-search picker is a natural next step here"),
// closing exactly that gap. Scoped to the same access rule
// addDemoItem itself already enforces (getEffectiveListPermission,
// above) — matching by SQL-level list_id filtering here rather than
// checking each candidate row individually after the fact, both for
// efficiency and so a connection/bookmark the requester genuinely
// can't see never appears in results in the first place, not even
// fleetingly.
// Same 2-character minimum as users/search's own — though the
// enumeration concern that route's own comment describes doesn't
// really apply here the same way (results are already scoped to lists
// this person can already see), an unbounded "everything" result for
// an empty query would still be a poor, unhelpful UX on its own.
// Extracted for the same reason as getResolvedDemoView/addDemoItem
// above — directly testable without a full HTTP-level test harness.
export async function searchDemoItems(userId: string, q: string) {
  if (q.trim().length < 2) return [];

  const admin = await isAdministrator(userId);
  const listFilter = admin ? '' : `AND list_id IN (
       SELECT list_id FROM list_user_permissions WHERE user_id = $2
       UNION
       SELECT lgp.list_id FROM list_group_permissions lgp
         JOIN user_groups ug ON ug.group_id = lgp.group_id
         WHERE ug.user_id = $2
     )`;
  const params = admin ? [`%${q}%`] : [`%${q}%`, userId];

  return db.any(
    `SELECT id, name, 'connection' AS item_type, protocol FROM connections
       WHERE name ILIKE $1 ${listFilter}
     UNION ALL
     SELECT id, name, 'bookmark' AS item_type, NULL AS protocol FROM bookmarks
       WHERE name ILIKE $1 ${listFilter}
     ORDER BY name LIMIT 20`,
    params,
  );
}

demosRouter.get('/searchable-items', async (req, res) => {
  res.json(await searchDemoItems(req.userId!, String(req.query.q ?? '')));
});

// Demos the user owns, plus demos someone else has granted them access to.
demosRouter.get('/', async (req, res) => {
  const owned = await db.any(
    `SELECT id, slug, title, description, created_at FROM demos WHERE owner_id = $1 ORDER BY title`,
    [req.userId]
  );
  const sharedWithMe = await db.any(
    `SELECT d.id, d.slug, d.title, d.description, d.created_at FROM demos d
       JOIN demo_access da ON da.demo_id = d.id
       WHERE da.user_id = $1 AND (da.expires_at IS NULL OR da.expires_at > now())
       ORDER BY d.title`,
    [req.userId]
  );
  res.json({ owned, sharedWithMe });
});

// Create a demo. Any authenticated user can — this is a personal curation
// tool (e.g. a presales engineer building "veeamdemo"), not an admin-only
// instance-wide feature.
demosRouter.post('/', async (req, res) => {
  const { slug, title, description } = req.body;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'invalid_slug', message: 'Slug must be lowercase letters, numbers, and hyphens.' });
  }
  try {
    const demo = await db.one(
      `INSERT INTO demos (slug, title, description, owner_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [slug, title, description ?? '', req.userId]
    );
    await logAuditFromRequest(req, 'demo_created', { demoId: demo.id, slug });
    res.json({ id: demo.id });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'slug_taken' });
    throw err;
  }
});

// Resolved view: what a demo viewer (owner or granted user) actually sees —
// the demo's own metadata plus the real connection/bookmark rows for each
// item, fetched directly rather than through the list-scoped endpoints,
// since a demo viewer may have no permission on the parent lists at all.
demosRouter.get('/:id', async (req, res) => {
  const view = await getResolvedDemoView(req.params.id, req.userId!);
  if (view.status === 'not_found') return res.status(404).json({ error: 'not_found' });
  if (view.status === 'not_authorized') return res.status(403).json({ error: 'not_authorized' });
  res.json(view);
});

demosRouter.put('/:id', async (req, res) => {
  if (!(await isOwner(req.params.id, req.userId!))) return res.status(403).json({ error: 'not_authorized' });
  const { title, description } = req.body;
  await db.none(`UPDATE demos SET title = $1, description = $2, updated_at = now() WHERE id = $3`, [
    title,
    description ?? '',
    req.params.id
  ]);
  await logAuditFromRequest(req, 'demo_updated', { demoId: req.params.id, title });
  res.json({ status: 'updated' });
});

demosRouter.delete('/:id', async (req, res) => {
  if (!(await isOwner(req.params.id, req.userId!))) return res.status(403).json({ error: 'not_authorized' });
  await db.none(`DELETE FROM demos WHERE id = $1`, [req.params.id]);
  await logAuditFromRequest(req, 'demo_deleted', { demoId: req.params.id });
  res.json({ status: 'deleted' });
});

demosRouter.post('/:id/items', async (req, res) => {
  const { itemType, itemId, sortOrder } = req.body;
  const result = await addDemoItem(req.params.id, req.userId!, itemType, itemId, sortOrder ?? 0);
  const statusCodes: Record<string, number> = {
    not_authorized: 403,
    invalid_item_type: 400,
    item_not_found: 404,
    no_access_to_source_item: 403,
    added: 200
  };
  if (result.status === 'added') {
    await logAuditFromRequest(req, 'demo_item_added', { demoId: req.params.id, itemType, itemId });
  }
  res.status(statusCodes[result.status]).json(result.status === 'added' ? { status: 'added' } : { error: result.status });
});

demosRouter.delete('/:id/items/:itemId', async (req, res) => {
  if (!(await isOwner(req.params.id, req.userId!))) return res.status(403).json({ error: 'not_authorized' });
  await db.none(`DELETE FROM demo_items WHERE demo_id = $1 AND id = $2`, [req.params.id, req.params.itemId]);
  await logAuditFromRequest(req, 'demo_item_removed', { demoId: req.params.id, itemId: req.params.itemId });
  res.json({ status: 'removed' });
});

// Grant a specific user access to the whole demo — exactly the items in
// demo_items, nothing about the underlying lists. expiresAt is optional
// (ISO string); omit it for a grant that never expires.
demosRouter.post('/:id/access', async (req, res) => {
  if (!(await isOwner(req.params.id, req.userId!))) return res.status(403).json({ error: 'not_authorized' });
  const { userId, expiresAt } = req.body;
  await db.none(
    `INSERT INTO demo_access (demo_id, user_id, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (demo_id, user_id) DO UPDATE SET expires_at = $3`,
    [req.params.id, userId, expiresAt ?? null]
  );
  await logAuditFromRequest(req, 'demo_access_granted', { demoId: req.params.id, granteeUserId: userId, expiresAt: expiresAt ?? null });
  res.json({ status: 'granted' });
});

demosRouter.delete('/:id/access/:userId', async (req, res) => {
  if (!(await isOwner(req.params.id, req.userId!))) return res.status(403).json({ error: 'not_authorized' });
  await db.none(`DELETE FROM demo_access WHERE demo_id = $1 AND user_id = $2`, [req.params.id, req.params.userId]);
  await logAuditFromRequest(req, 'demo_access_revoked', { demoId: req.params.id, granteeUserId: req.params.userId });
  res.json({ status: 'revoked' });
});

demosRouter.get('/:id/access', async (req, res) => {
  if (!(await isOwner(req.params.id, req.userId!))) return res.status(403).json({ error: 'not_authorized' });
  const grants = await db.any(
    `SELECT u.id, u.username, da.granted_at, da.expires_at,
            (da.expires_at IS NOT NULL AND da.expires_at <= now()) AS is_expired
     FROM demo_access da
       JOIN users u ON u.id = da.user_id WHERE da.demo_id = $1 ORDER BY u.username`,
    [req.params.id]
  );
  res.json(grants);
});
