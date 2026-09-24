import { Router } from 'express';
import net from 'net';
import { db } from '../db';
import { getEffectiveListPermission, requireListPermission } from '../services/permissions';
import { provisionPersonalList, grantListPermission } from '../services/userProvisioning';

export const connectionsRouter = Router();

const REACHABILITY_TIMEOUT_MS = 5000;

/**
 * Tests raw TCP reachability from the backend container to a given
 * hostname:port — requested directly, after this app's own live
 * deployment needed exactly this kind of check run manually (via `nc`)
 * multiple times to diagnose real connection failures. Surfacing it in
 * the UI at the point a connection is actually being created/edited
 * means the person setting it up finds out immediately, not after
 * clicking Connect and staring at a spinner.
 *
 * Deliberately just a TCP connect check, not a full protocol handshake
 * (RDP/SSH/VNC) — this tests from the BACKEND container specifically,
 * not from guacd (which is what actually opens the real downstream
 * connection). In this app's own default topology backend and guacd
 * share the same Docker network with equivalent outbound reachability,
 * so this is a genuinely useful signal in the common case, but it's not
 * a perfect guarantee of guacd's own reachability if a deployment ever
 * gives the two different network policies — the tunnel-token flow
 * itself remains the actual, authoritative test.
 */
export function testTcpReachability(hostname: string, port: number): Promise<{ reachable: boolean; message: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    function finish(result: { reachable: boolean; message: string }) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    }

    socket.setTimeout(REACHABILITY_TIMEOUT_MS);
    socket.once('connect', () => finish({ reachable: true, message: 'Reachable' }));
    socket.once('timeout', () => finish({ reachable: false, message: `No response within ${REACHABILITY_TIMEOUT_MS / 1000}s` }));
    socket.once('error', (err: Error) => finish({ reachable: false, message: err.message }));

    socket.connect(port, hostname);
  });
}

connectionsRouter.post('/test-reachability', async (req, res) => {
  const { hostname, port } = req.body;
  if (!hostname || !port) {
    return res.status(400).json({ error: 'invalid_input', message: 'hostname and port are required.' });
  }
  const result = await testTcpReachability(hostname, Number(port));
  res.json(result);
});

// Returns (and defensively creates, if somehow missing — e.g. an account
// created before this feature existed) the user's private personal list.
connectionsRouter.get('/my-list', async (req, res) => {
  let list = await db.oneOrNone(
    `SELECT id, name, description FROM connection_lists WHERE owner_id = $1 AND is_personal = true`,
    [req.userId]
  );
  if (!list) {
    const id = await provisionPersonalList(req.userId!);
    list = await db.one(`SELECT id, name, description FROM connection_lists WHERE id = $1`, [id]);
  }
  res.json(list);
});

// Lists visible to the current user: their personal list plus any shared
// list they have a direct or group-inherited grant on. Both come from the
// same permission tables — a personal list's owner just happens to hold an
// 'admin' grant on it from the moment it was created.
connectionsRouter.get('/lists', async (req, res) => {
  const lists = await db.any(
    `SELECT DISTINCT cl.id, cl.name, cl.description, cl.is_personal FROM connection_lists cl
     LEFT JOIN list_user_permissions lup ON lup.list_id = cl.id AND lup.user_id = $1
     LEFT JOIN list_group_permissions lgp ON lgp.list_id = cl.id
     LEFT JOIN user_groups ug ON ug.group_id = lgp.group_id AND ug.user_id = $1
     WHERE lup.user_id IS NOT NULL OR ug.user_id IS NOT NULL
     ORDER BY cl.is_personal DESC, cl.name`,
    [req.userId]
  );
  // The caller's own effective permission level per list — previously
  // missing entirely, which meant the frontend had no way to know
  // whether "Add connection" should even be offered for a given list
  // (POST /lists/:listId/connections requires 'edit', not admin-only —
  // every user already has 'admin' on their own personal list, and
  // could be granted 'edit'+ on a shared one too). A small number of
  // lists per user in practice, so a straightforward per-list lookup
  // here is clearer than folding MAX(rank) logic into the query above.
  const withPermissions = await Promise.all(
    lists.map(async (list) => ({
      ...list,
      permission: await getEffectiveListPermission(req.userId!, list.id)
    }))
  );
  res.json(withPermissions);
});

connectionsRouter.get('/lists/:id/connections', async (req, res) => {
  const allowed = await getEffectiveListPermission(req.userId!, req.params.id);
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const connections = await db.any(
    `SELECT c.id, c.name, c.protocol, c.hostname, c.port, c.credential_mode, c.force_record, c.folder_id, c.params
     FROM connections c
     LEFT JOIN connection_folders f ON f.id = c.folder_id
     WHERE c.list_id = $1 ORDER BY f.name NULLS FIRST, c.name`,
    [req.params.id]
  );
  res.json({ permission: allowed, connections });
});

// Export a list as a portable JSON blob — metadata + params only, credentials
// are never included regardless of credential_mode.
connectionsRouter.get('/lists/:id/export', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.id, 'view');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const list = await db.one(`SELECT name, description FROM connection_lists WHERE id = $1`, [req.params.id]);
  const connections = await db.any(
    `SELECT name, protocol, hostname, port, credential_mode, params FROM connections WHERE list_id = $1`,
    [req.params.id]
  );

  res.json({
    schema_version: 1,
    list_name: list.name,
    description: list.description,
    exported_at: new Date().toISOString(),
    connections
  });
});

// Import always lands in a new shared list — a personal list is meant to
// stay each user's own space, so bulk-importing into someone else's isn't
// exposed here.
connectionsRouter.post('/lists/import', async (req, res) => {
  const { schema_version, list_name, description, connections } = req.body;
  if (schema_version !== 1) return res.status(400).json({ error: 'unsupported_schema_version' });

  const list = await db.one(
    `INSERT INTO connection_lists (name, description, owner_id, is_personal) VALUES ($1, $2, $3, false) RETURNING id`,
    [list_name, description ?? '', req.userId]
  );
  await grantListPermission(list.id, req.userId!, 'admin');

  for (const c of connections) {
    await db.none(
      `INSERT INTO connections (list_id, name, protocol, hostname, port, credential_mode, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [list.id, c.name, c.protocol, c.hostname, c.port, c.credential_mode, JSON.stringify(c.params ?? {})]
    );
  }

  // Imported connections in 'shared' credential mode have no credentials yet
  // — flagged here so the frontend can prompt an admin to assign them.
  const needsCredentials = connections.filter((c: any) => c.credential_mode === 'shared');

  res.json({ listId: list.id, needsCredentialAssignment: needsCredentials.map((c: any) => c.name) });
});
