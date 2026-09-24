import { db } from '../db';

const RANK: Record<string, number> = { view: 1, connect: 2, edit: 3, admin: 4 };

/**
 * True if the user is a member of the global 'Administrators' group —
 * completely independent of any list-specific permission grant. Moved
 * here from admin.ts (where it was previously local/unexported) so
 * requireListPermission below can use it too, not just admin.ts's own
 * requireAdmin() route guard.
 */
export async function isAdministrator(userId: string): Promise<boolean> {
  const row = await db.oneOrNone(
    `SELECT 1 FROM user_groups ug JOIN groups g ON g.id = ug.group_id
     WHERE ug.user_id = $1 AND g.name = 'Administrators'`,
    [userId]
  );
  return !!row;
}

/**
 * Returns the highest permission level a user has on a given connection list,
 * combining direct user grants and any grants via group membership. This
 * covers both shared lists (granted via admin.ts) and personal lists — a
 * personal list's owner gets an explicit 'admin' row in list_user_permissions
 * at creation time (see services/userProvisioning.ts), so no special-casing
 * is needed here; it's the same lookup either way.
 * Returns null if the user has no access at all.
 */
/**
 * Returns the highest permission level a user has on a given connection list,
 * combining direct user grants and any grants via group membership. This
 * covers both shared lists (granted via admin.ts) and personal lists — a
 * personal list's owner gets an explicit 'admin' row in list_user_permissions
 * at creation time (see services/userProvisioning.ts), so no special-casing
 * is needed here; it's the same lookup either way.
 * Returns null if the user has no access at all.
 *
 * Real, pre-existing gap found and fixed here (not introduced): this used
 * to check ONLY list_user_permissions/list_group_permissions, with no
 * awareness of global 'Administrators' group membership at all — a
 * genuine multi-admin deployment (the Administrators group is a group,
 * not a single flag, so this is a real, designed-for case, not an edge
 * case) meant a second admin who simply never received an explicit grant
 * on a list created by the first couldn't manage that list at all,
 * anywhere permission is checked through this function or through
 * requireListPermission below (which calls it) — including bookmarks.ts
 * and demos.ts, which check this directly rather than through
 * requireListPermission, and connections.ts, which returns this value
 * straight to the frontend to decide what UI to offer. Fixed at this
 * single source rather than patching requireListPermission alone, which
 * would have left those other callers still inconsistent. The
 * 'Administrators' group already means "can manage everything
 * instance-wide" everywhere else it's checked (admin.ts's own
 * requireAdmin) — this was an inconsistency with that, not intentional
 * per-admin scoping.
 */
export async function getEffectiveListPermission(userId: string, listId: string): Promise<string | null> {
  if (await isAdministrator(userId)) return 'admin';
  const rows = await db.any(
    `SELECT permission FROM list_user_permissions WHERE list_id = $1 AND user_id = $2
     UNION
     SELECT lgp.permission FROM list_group_permissions lgp
       JOIN user_groups ug ON ug.group_id = lgp.group_id
       WHERE lgp.list_id = $1 AND ug.user_id = $2`,
    [listId, userId]
  );
  if (rows.length === 0) return null;
  return rows.reduce((best: string | null, r: { permission: string }) =>
    !best || RANK[r.permission] > RANK[best] ? r.permission : best, null);
}

export async function requireListPermission(userId: string, listId: string, minLevel: string): Promise<boolean> {
  const perm = await getEffectiveListPermission(userId, listId);
  if (!perm) return false;
  return RANK[perm] >= RANK[minLevel];
}

/**
 * True if the user has been granted access to a demo that includes this
 * connection as an item (see migrations/011_demos.sql). Demo access is
 * capped at 'connect'-equivalent — enough to launch/view a session, never
 * enough to edit the connection or see the rest of its parent list.
 */
export async function hasDemoAccessToConnection(userId: string, connectionId: string): Promise<boolean> {
  const row = await db.oneOrNone(
    `SELECT 1 FROM demo_access da
       JOIN demo_items di ON di.demo_id = da.demo_id
       WHERE da.user_id = $1 AND di.item_type = 'connection' AND di.item_id = $2
         AND (da.expires_at IS NULL OR da.expires_at > now())`,
    [userId, connectionId]
  );
  return !!row;
}

export async function hasDemoAccessToBookmark(userId: string, bookmarkId: string): Promise<boolean> {
  const row = await db.oneOrNone(
    `SELECT 1 FROM demo_access da
       JOIN demo_items di ON di.demo_id = da.demo_id
       WHERE da.user_id = $1 AND di.item_type = 'bookmark' AND di.item_id = $2
         AND (da.expires_at IS NULL OR da.expires_at > now())`,
    [userId, bookmarkId]
  );
  return !!row;
}

/**
 * Combined check used anywhere a connection is actually launched/used
 * (tunnel token issuance, guacd connection settings, file paste): either the
 * normal list-permission path at 'connect' or above, OR — for anything not
 * requiring more than 'connect' — a demo grant covering this specific item.
 * A demo grant never satisfies 'edit'/'admin' checks, since curating a demo
 * shouldn't imply any ability to modify the underlying connection.
 */
export async function hasConnectionAccess(userId: string, connectionId: string, minLevel: string): Promise<boolean> {
  const connection = await db.oneOrNone(`SELECT list_id FROM connections WHERE id = $1`, [connectionId]);
  if (!connection) return false;

  if (await requireListPermission(userId, connection.list_id, minLevel)) return true;
  if (RANK[minLevel] <= RANK.connect && (await hasDemoAccessToConnection(userId, connectionId))) return true;
  return false;
}

export async function hasBookmarkAccess(userId: string, bookmarkId: string, minLevel: string): Promise<boolean> {
  const bookmark = await db.oneOrNone(`SELECT list_id FROM bookmarks WHERE id = $1`, [bookmarkId]);
  if (!bookmark) return false;

  if (await requireListPermission(userId, bookmark.list_id, minLevel)) return true;
  if (RANK[minLevel] <= RANK.view && (await hasDemoAccessToBookmark(userId, bookmarkId))) return true;
  return false;
}

/**
 * Policy given directly: an admin (list-level 'admin' permission on the
 * recording's connection's list) can always view/play/delete a
 * recording; otherwise only the person who made it can. No other
 * permission level (view/edit/connect) grants anything here — a
 * recording can capture on-screen content more sensitive than the
 * connection's own name/hostname, so this is intentionally narrower
 * than hasConnectionAccess's own graduated levels.
 *
 * The creator check comes first and is unconditional: it's what keeps
 * this working even for a recording whose connection has since been
 * deleted (connection_id NULL, migration 016's own ON DELETE SET NULL)
 * — there's no list left to check admin permission against at all in
 * that case, so the creator's own access would otherwise silently
 * disappear along with the connection, which isn't what was asked for.
 */
export async function canAccessRecording(userId: string, recordingId: string): Promise<boolean> {
  const recording = await db.oneOrNone(
    `SELECT user_id, connection_id FROM session_recordings WHERE id = $1`,
    [recordingId]
  );
  if (!recording) return false;
  if (recording.user_id === userId) return true;
  if (!recording.connection_id) return false;

  const connection = await db.oneOrNone(`SELECT list_id FROM connections WHERE id = $1`, [recording.connection_id]);
  if (!connection) return false;
  return requireListPermission(userId, connection.list_id, 'admin');
}
