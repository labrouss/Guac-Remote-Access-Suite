import { Router } from 'express';
import { db } from '../db';

export const auditLogRouter = Router();

async function isAdministrator(userId: string): Promise<boolean> {
  const row = await db.oneOrNone(
    `SELECT 1 FROM user_groups ug JOIN groups g ON g.id = ug.group_id
     WHERE ug.user_id = $1 AND g.name = 'Administrators'`,
    [userId]
  );
  return !!row;
}

/**
 * Closes the "audit_log is populated everywhere but nobody can browse it"
 * gap — admin-only, filterable, paginated. Deliberately conservative on
 * filters (exact match on user/action/connection, range on date) rather
 * than free-text search across the JSON `detail` column, which would need
 * either a GIN index on `detail` or accepting slow sequential scans on a
 * table that's meant to grow indefinitely.
 */
auditLogRouter.get('/', async (req, res) => {
  if (!(await isAdministrator(req.userId!))) return res.status(403).json({ error: 'admin_only' });

  const { userId, action, connectionId, from, to } = req.query;
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50)));
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: any[] = [];

  if (userId) {
    params.push(userId);
    conditions.push(`al.user_id = $${params.length}`);
  }
  if (action) {
    params.push(action);
    conditions.push(`al.action = $${params.length}`);
  }
  if (connectionId) {
    params.push(connectionId);
    conditions.push(`al.connection_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`al.created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`al.created_at <= $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  params.push(pageSize, offset);
  const rows = await db.any(
    `SELECT al.id, al.action, al.detail, al.source_ip, al.created_at,
            u.username, al.connection_id, c.name AS connection_name
     FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       LEFT JOIN connections c ON c.id = al.connection_id
     ${whereClause}
     ORDER BY al.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const countParams = params.slice(0, params.length - 2);
  const { count } = await db.one(
    `SELECT count(*) FROM audit_log al ${whereClause}`,
    countParams
  );

  res.json({ rows, total: Number(count), page, pageSize });
});

// Every distinct action string ever logged, for populating the filter
// dropdown in the frontend without hardcoding the list (which would drift
// out of sync as new action types get added across the codebase).
auditLogRouter.get('/actions', async (req, res) => {
  if (!(await isAdministrator(req.userId!))) return res.status(403).json({ error: 'admin_only' });
  const rows = await db.any(`SELECT DISTINCT action FROM audit_log ORDER BY action`);
  res.json(rows.map((r: any) => r.action));
});
