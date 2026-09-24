import { Router } from 'express';
import argon2 from 'argon2';
import { db } from '../db';
import { requireListPermission } from '../services/permissions';
import { provisionPersonalList, grantListPermission } from '../services/userProvisioning';
import { logAuditFromRequest } from '../services/auditLog';
import { clearAdPassthroughCredential, isAdEnabled } from '../services/activeDirectory';
import { removeUser } from '../services/userRemoval';

// NOTE ON NAMING: mounted at /api/admin, but not every route here requires
// the global 'Administrators' group — routes gated by requireAdmin() are
// instance-wide admin actions (creating users/groups), while routes gated by
// requireListPermission() are scoped to whoever has the right permission on
// that specific list (e.g. any user can add a connection to their own
// personal list, since they hold 'admin' on it from provisionPersonalList).
//
// AUDIT LOGGING: every mutating route below logs via logAuditFromRequest.
// An audit of this file before adding that found only 2 of ~18 routes here
// had any audit entry at all — the rest are filled in below, not just the
// two that already existed.
export const adminRouter = Router();

const VALID_CREDENTIAL_MODES = new Set(['shared', 'individual', 'ad_passthrough']);

// Requested directly, for the connection form's own credential-mode
// selector (EditConnectionModal.tsx / AddConnectionForm.tsx) to know
// whether to even offer "AD passthrough" as an option at all — offering
// it on a deployment with no AD configured would be actively misleading,
// since it could never work there (every user would hit
// ad_credential_unavailable, forever, no matter what).
//
// Deliberately NOT requireAdmin — a real bug caught before it shipped,
// not the original design: AddConnectionForm.tsx is specifically the
// regular-user-facing connection form (any user with 'edit' on a list
// can create a connection there, admin or not), so gating this behind
// requireAdmin would have meant every non-admin user permanently got a
// 403 here and could never see or choose AD passthrough at all, even
// on a deployment where it's fully enabled — caught by tracing through
// who actually calls this, not assumed safe because admin.ts's other
// routes mostly are gated that way. What this endpoint actually reveals
// — one boolean, whether AD is configured at all — carries none of the
// sensitivity an admin-only gate exists to protect (unlike, say, the
// AD_BIND_DN or AD_REQUIRED_GROUP_DN values themselves, which this
// deliberately never exposes), so any authenticated user is fine here;
// requireAuth's own global middleware already covers that.
adminRouter.get('/ad-status', async (_req, res) => {
  res.json({ enabled: isAdEnabled() });
});

async function isAdministrator(userId: string): Promise<boolean> {
  const row = await db.oneOrNone(
    `SELECT 1 FROM user_groups ug JOIN groups g ON g.id = ug.group_id
     WHERE ug.user_id = $1 AND g.name = 'Administrators'`,
    [userId]
  );
  return !!row;
}

function requireAdmin(handler: (req: any, res: any) => Promise<void>) {
  return async (req: any, res: any) => {
    if (!(await isAdministrator(req.userId))) return res.status(403).json({ error: 'admin_only' });
    return handler(req, res);
  };
}

// Requested directly, for the "Quick connect" ad-hoc-connection button
// (AppShell.tsx) to know whether to even show itself to the current
// user — the real enforcement is server-side already (requireAdmin on
// the actual token-issuing route itself, routes/tunnelToken.ts's
// issueAdhocConnectionToken), this is purely so a non-admin never sees
// a button that would just reject them after they'd already filled out
// the whole form. requireAdmin already means a non-admin never reaches
// this handler at all — a 403 either way, so the response body here can
// just be a static confirmation.
adminRouter.get('/am-i-admin', requireAdmin(async (_req, res) => {
  res.json({ isAdmin: true });
}));

// --- Users ---
adminRouter.get('/users', requireAdmin(async (_req, res) => {
  res.json(await db.any(
    `SELECT u.id, u.username, u.totp_enabled, u.created_at, u.disabled_at,
            COALESCE(
              json_agg(json_build_object('id', g.id, 'name', g.name)) FILTER (WHERE g.id IS NOT NULL),
              '[]'
            ) AS groups
     FROM users u
     LEFT JOIN user_groups ug ON ug.user_id = u.id
     LEFT JOIN groups g ON g.id = ug.group_id
     GROUP BY u.id
     ORDER BY u.username`
  ));
}));

adminRouter.post('/users', requireAdmin(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 12) {
    return res.status(400).json({ error: 'invalid_input', message: 'Password must be at least 12 characters.' });
  }
  const passwordHash = await argon2.hash(password);
  const user = await db.one(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id`,
    [username, passwordHash]
  );
  // Every user gets a private space immediately — they don't need an admin
  // to set up a shared list before they can use the tool at all.
  const personalListId = await provisionPersonalList(user.id);
  await logAuditFromRequest(req, 'user_created', { newUserId: user.id, username });
  res.json({ id: user.id, personalListId });
}));

adminRouter.delete('/users/:id', requireAdmin(async (req, res) => {
  await db.none(`UPDATE users SET disabled_at = now() WHERE id = $1`, [req.params.id]);
  // A disabled account's own cached AD password (if any — harmless,
  // resolving to a no-op delete for a local account that never had one)
  // shouldn't keep sitting around, decryptable, until whatever's left of
  // its own separate expiry window happens to run out — an admin's
  // disable action is meant to take effect immediately, not eventually.
  await clearAdPassthroughCredential(req.params.id);
  await logAuditFromRequest(req, 'user_disabled', { targetUserId: req.params.id });
  res.json({ status: 'disabled' });
}));

adminRouter.put('/users/:id', requireAdmin(async (req, res) => {
  const { username } = req.body;
  if (!username || !/^[a-zA-Z0-9_.-]{2,64}$/.test(username)) {
    return res.status(400).json({ error: 'invalid_username' });
  }
  try {
    await db.none(`UPDATE users SET username = $1 WHERE id = $2`, [username, req.params.id]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'username_taken' });
    throw err;
  }
  await logAuditFromRequest(req, 'username_changed', { targetUserId: req.params.id, newUsername: username });
  res.json({ status: 'renamed' });
}));

// Re-enable a previously disabled account.
adminRouter.post('/users/:id/enable', requireAdmin(async (req, res) => {
  await db.none(`UPDATE users SET disabled_at = NULL WHERE id = $1`, [req.params.id]);
  await logAuditFromRequest(req, 'user_enabled', { targetUserId: req.params.id });
  res.json({ status: 'enabled' });
}));

// Actually removes the account — a real, distinct need from disable
// above, requested directly (disable alone never frees the username
// or takes the account out of the users list; this genuinely does).
// Irreversible, unlike disable, so two safety checks disable itself
// doesn't have: can't remove your own account (an admin locking
// themselves out mid-session, with no one else able to undo it), and
// can't remove the last remaining Administrators member (the same
// scenario, but for everyone at once). See userRemoval.ts's own
// comment for what actually happens to the account's data — audit
// history and anything shared with other people is deliberately
// preserved, not cascade-deleted.
adminRouter.post('/users/:id/remove', requireAdmin(async (req, res) => {
  if (req.params.id === req.userId) {
    return res.status(400).json({ error: 'cannot_remove_self' });
  }
  if (await isAdministrator(req.params.id)) {
    const adminCount = await db.one(
      `SELECT count(*) FROM user_groups ug JOIN groups g ON g.id = ug.group_id WHERE g.name = 'Administrators'`,
    );
    if (Number(adminCount.count) <= 1) {
      return res.status(400).json({ error: 'cannot_remove_last_administrator' });
    }
  }
  const user = await db.oneOrNone(`SELECT username FROM users WHERE id = $1`, [req.params.id]);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  await removeUser(req.params.id);
  await logAuditFromRequest(req, 'user_removed', { targetUserId: req.params.id, targetUsername: user.username });
  res.json({ status: 'removed' });
}));

// Admin-initiated reset: no email/SMTP dependency, deliberately simple. Sets
// a temporary password the admin communicates out of band, and flags the
// account so the user is forced to set their own password on next login
// before reaching the rest of the app (see routes/me.ts + the frontend's
// post-login gate).
adminRouter.post('/users/:id/reset-password', requireAdmin(async (req, res) => {
  const { temporaryPassword } = req.body;
  if (!temporaryPassword || temporaryPassword.length < 12) {
    return res.status(400).json({ error: 'invalid_input', message: 'Password must be at least 12 characters.' });
  }
  const passwordHash = await argon2.hash(temporaryPassword);
  await db.none(
    `UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2`,
    [passwordHash, req.params.id]
  );
  await logAuditFromRequest(req, 'password_reset_by_admin', { targetUserId: req.params.id });
  res.json({ status: 'reset' });
}));

// Clears the user's existing 2FA enrollment entirely — they'll need to set
// it up again (see the new self-service POST /me/totp/enroll +
// POST /me/totp/verify) before it's required at login again. This is the
// only way an admin can act on a user's 2FA at all: unlike a password,
// enrolling 2FA needs the user's own authenticator app to scan a QR code,
// so an admin can never enroll it "for" them — only clear an existing
// enrollment, e.g. for someone who lost their device and is locked out.
adminRouter.post('/users/:id/reset-totp', requireAdmin(async (req, res) => {
  await db.none(
    `UPDATE users SET totp_secret_encrypted = NULL, totp_enabled = false WHERE id = $1`,
    [req.params.id]
  );
  await logAuditFromRequest(req, 'totp_reset_by_admin', { targetUserId: req.params.id });
  res.json({ status: 'reset' });
}));

// --- Groups ---
adminRouter.get('/groups', requireAdmin(async (_req, res) => {
  res.json(await db.any(`SELECT id, name, description FROM groups ORDER BY name`));
}));

adminRouter.post('/groups', requireAdmin(async (req, res) => {
  const { name, description } = req.body;
  const group = await db.one(
    `INSERT INTO groups (name, description) VALUES ($1, $2) RETURNING id`,
    [name, description ?? '']
  );
  await logAuditFromRequest(req, 'group_created', { groupId: group.id, name });
  res.json({ id: group.id });
}));

adminRouter.get('/groups/:groupId/members', requireAdmin(async (req, res) => {
  // source included so the admin panel can show which members are
  // here because of AD group sync (migration 022) vs. added by hand —
  // requested directly, since removing an ad_sync-derived member
  // through the button just below doesn't actually stick (their next
  // AD login re-adds it), and an admin has no way to know that's about
  // to happen without this.
  const members = await db.any(
    `SELECT u.id, u.username, ug.source FROM user_groups ug JOIN users u ON u.id = ug.user_id
     WHERE ug.group_id = $1 ORDER BY u.username`,
    [req.params.groupId]
  );
  res.json(members);
}));

adminRouter.post('/groups/:groupId/members', requireAdmin(async (req, res) => {
  const { userId } = req.body;
  await db.none(
    `INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, req.params.groupId]
  );
  await logAuditFromRequest(req, 'group_member_added', { groupId: req.params.groupId, addedUserId: userId });
  res.json({ status: 'added' });
}));

adminRouter.delete('/groups/:groupId/members/:userId', requireAdmin(async (req, res) => {
  await db.none(`DELETE FROM user_groups WHERE group_id = $1 AND user_id = $2`, [req.params.groupId, req.params.userId]);
  await logAuditFromRequest(req, 'group_member_removed', { groupId: req.params.groupId, removedUserId: req.params.userId });
  res.json({ status: 'removed' });
}));

// The Administrators group is seeded at install time and relied on by name
// (setup.ts, admin.ts user creation) to bootstrap admin access — deleting it
// would silently break both, so it's protected here rather than left as a
// footgun.
adminRouter.delete('/groups/:groupId', requireAdmin(async (req, res) => {
  const group = await db.oneOrNone(`SELECT name FROM groups WHERE id = $1`, [req.params.groupId]);
  if (!group) return res.status(404).json({ error: 'not_found' });
  if (group.name === 'Administrators') {
    return res.status(400).json({ error: 'cannot_delete_administrators_group' });
  }
  await db.none(`DELETE FROM groups WHERE id = $1`, [req.params.groupId]);
  await logAuditFromRequest(req, 'group_deleted', { groupId: req.params.groupId, name: group.name });
  res.json({ status: 'deleted' });
}));

// Requested directly: setting a group's connection-list permissions from
// the group's own admin view, not only the reverse (a list's own
// "Grant access — group" section, which already existed via
// POST/DELETE /lists/:id/permissions/group below — this reuses those
// same two routes; the only new piece is this listing, the group-centric
// side of the same operation, matching the identical
// group-vs-user-centric pattern already established for group
// *membership* a couple of rounds back.
adminRouter.get('/groups/:groupId/permissions', requireAdmin(async (req, res) => {
  const grants = await db.any(
    `SELECT lgp.list_id, cl.name AS list_name, lgp.permission FROM list_group_permissions lgp
     JOIN connection_lists cl ON cl.id = lgp.list_id
     WHERE lgp.group_id = $1 ORDER BY cl.name, lgp.permission`,
    [req.params.groupId]
  );
  res.json(grants);
}));

// --- Connection lists ---
// Real, pre-existing gap found while building group-permission
// management below, not introduced by it: ListsTab previously fetched
// from GET /api/connections/lists, which — correctly, for its own
// purpose — only returns lists the *calling* user already has some
// permission grant on (see that route's own comment). requireAdmin here
// checks global 'Administrators' group membership, completely
// independent of any list-specific grant; a global admin who simply
// never happened to receive an explicit grant on some particular list
// (e.g. one created by a different admin) couldn't see it in their own
// admin panel at all, let alone manage it — the Administrators group is
// clearly meant to mean "can manage everything instance-wide," so this
// was an inconsistency, not intentional per-admin scoping. This route
// is what ListsTab now actually uses.
adminRouter.get('/lists', requireAdmin(async (_req, res) => {
  // Real bug found live: this returned every connection_lists row with
  // no filtering at all, including every individual user's own
  // auto-provisioned personal "My Connections" list (one per user,
  // created automatically by provisionPersonalList) — on any instance
  // with more than a couple of users, this admin-facing "Lists" tab
  // filled up with dozens of identically-named, unmanageable entries.
  // Personal lists were never meant to appear here at all: they can't be
  // shared (the grant route's own personal_lists_cannot_be_shared check
  // already reflects this) and can't be deleted from this view either
  // (ListDetail's own is_personal guard on the delete button). This tab
  // is specifically for managing shared lists — excluding is_personal
  // entirely, not just deprioritizing them in sort order, is what
  // actually matches that purpose.
  res.json(await db.any(
    `SELECT id, name, description, is_personal FROM connection_lists WHERE is_personal = false ORDER BY name`
  ));
}));

adminRouter.post('/lists', requireAdmin(async (req, res) => {
  const { name, description } = req.body;
  const list = await db.one(
    `INSERT INTO connection_lists (name, description, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, description ?? '', req.userId]
  );
  await grantListPermission(list.id, req.userId, 'admin');
  await logAuditFromRequest(req, 'list_created', { name }, undefined);
  res.json({ id: list.id });
}));

adminRouter.put('/lists/:id', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.id, 'admin');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { name, description } = req.body;
  await db.none(
    `UPDATE connection_lists SET name = $1, description = $2, updated_at = now() WHERE id = $3`,
    [name, description ?? '', req.params.id]
  );
  await logAuditFromRequest(req, 'list_updated', { listId: req.params.id, name });
  res.json({ status: 'updated' });
});

adminRouter.delete('/lists/:id', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.id, 'admin');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const list = await db.one(`SELECT is_personal FROM connection_lists WHERE id = $1`, [req.params.id]);
  if (list.is_personal) return res.status(400).json({ error: 'cannot_delete_personal_list' });

  await db.none(`DELETE FROM connection_lists WHERE id = $1`, [req.params.id]);
  await logAuditFromRequest(req, 'list_deleted', { listId: req.params.id });
  res.json({ status: 'deleted' });
});

// --- Permission grants on a list ---
adminRouter.post('/lists/:id/permissions/user', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.id, 'admin');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const list = await db.one(`SELECT is_personal FROM connection_lists WHERE id = $1`, [req.params.id]);
  if (list.is_personal) return res.status(400).json({ error: 'personal_lists_cannot_be_shared' });

  const { userId, permission } = req.body;
  await db.none(
    `INSERT INTO list_user_permissions (list_id, user_id, permission) VALUES ($1, $2, $3)
     ON CONFLICT (list_id, user_id, permission) DO NOTHING`,
    [req.params.id, userId, permission]
  );
  await logAuditFromRequest(req, 'list_permission_granted', { listId: req.params.id, granteeUserId: userId, permission });
  res.json({ status: 'granted' });
});

adminRouter.post('/lists/:id/permissions/group', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.id, 'admin');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const list = await db.one(`SELECT is_personal FROM connection_lists WHERE id = $1`, [req.params.id]);
  if (list.is_personal) return res.status(400).json({ error: 'personal_lists_cannot_be_shared' });

  const { groupId, permission } = req.body;
  await db.none(
    `INSERT INTO list_group_permissions (list_id, group_id, permission) VALUES ($1, $2, $3)
     ON CONFLICT (list_id, group_id, permission) DO NOTHING`,
    [req.params.id, groupId, permission]
  );
  await logAuditFromRequest(req, 'list_permission_granted', { listId: req.params.id, granteeGroupId: groupId, permission });
  res.json({ status: 'granted' });
});

// Revokes a single permission level for one user/group on a list — not all
// of that user/group's access, since someone can hold several levels at
// once (e.g. both 'view' and 'edit' rows) and revoking should be precise
// about which one is being pulled back.
adminRouter.delete('/lists/:id/permissions/user/:userId/:permission', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.id, 'admin');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  await db.none(
    `DELETE FROM list_user_permissions WHERE list_id = $1 AND user_id = $2 AND permission = $3`,
    [req.params.id, req.params.userId, req.params.permission]
  );
  await logAuditFromRequest(req, 'list_permission_revoked', {
    listId: req.params.id,
    granteeUserId: req.params.userId,
    permission: req.params.permission
  });
  res.json({ status: 'revoked' });
});

adminRouter.delete('/lists/:id/permissions/group/:groupId/:permission', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.id, 'admin');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  await db.none(
    `DELETE FROM list_group_permissions WHERE list_id = $1 AND group_id = $2 AND permission = $3`,
    [req.params.id, req.params.groupId, req.params.permission]
  );
  await logAuditFromRequest(req, 'list_permission_revoked', {
    listId: req.params.id,
    granteeGroupId: req.params.groupId,
    permission: req.params.permission
  });
  res.json({ status: 'revoked' });
});

// Lists every permission grant on a list (both direct-user and via-group),
// so the admin UI can show and revoke them individually rather than only
// ever adding new ones.
adminRouter.get('/lists/:id/permissions', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.id, 'admin');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const userGrants = await db.any(
    `SELECT lup.user_id, u.username, lup.permission FROM list_user_permissions lup
       JOIN users u ON u.id = lup.user_id WHERE lup.list_id = $1 ORDER BY u.username, lup.permission`,
    [req.params.id]
  );
  const groupGrants = await db.any(
    `SELECT lgp.group_id, g.name, lgp.permission FROM list_group_permissions lgp
       JOIN groups g ON g.id = lgp.group_id WHERE lgp.list_id = $1 ORDER BY g.name, lgp.permission`,
    [req.params.id]
  );
  res.json({ userGrants, groupGrants });
});

// --- Connections within a list ---
adminRouter.post('/lists/:listId/connections', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.listId, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { name, protocol, hostname, port, credentialMode, forceRecord, params, folderId } = req.body;
  // Validated explicitly here, not left to the database's own check
  // constraint (migration 021) to reject a bad value — that would
  // surface as a raw, unhandled 500 rather than a clean 400. AD
  // passthrough specifically also requires AD to actually be enabled on
  // this deployment: the connection form only ever offers it as an
  // option once GET /admin/ad-status says so, but that's client-side
  // gating only — enforced again here so a direct API call can't set it
  // on a deployment where it could never work, leaving every future
  // attempt to connect permanently failing with ad_credential_unavailable.
  if (!VALID_CREDENTIAL_MODES.has(credentialMode)) {
    return res.status(400).json({ error: 'invalid_credential_mode' });
  }
  if (credentialMode === 'ad_passthrough' && !isAdEnabled()) {
    return res.status(400).json({ error: 'ad_not_configured' });
  }
  const connection = await db.one(
    `INSERT INTO connections (list_id, name, protocol, hostname, port, credential_mode, force_record, params, folder_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    // Real bug found live, affecting every one of these six sites: `??`
    // only falls back on null/undefined, not an empty string — and a
    // <select> defaulting to "No folder" naturally submits folderId as
    // '', not null. That empty string went straight into folder_id, a
    // UUID column, which Postgres rejects outright with a type error —
    // a 500, shown to the user as a generic, unexplained "could not
    // save" with no indication a folder was ever involved at all. `||`
    // here instead of `??`, deliberately: folderId is always either a
    // real UUID string or empty/absent, never a legitimate falsy value
    // (unlike, say, a numeric field where 0 could be meaningful), so
    // treating every other falsy case the same as missing is correct
    // and safe here.
    [req.params.listId, name, protocol, hostname, port, credentialMode, forceRecord ?? false, JSON.stringify(params ?? {}), folderId || null]
  );
  await logAuditFromRequest(req, 'connection_created', { listId: req.params.listId, name, protocol, hostname }, connection.id);
  res.json({ id: connection.id });
});

adminRouter.put('/connections/:id', async (req, res) => {
  const connection = await db.one(`SELECT list_id FROM connections WHERE id = $1`, [req.params.id]);
  const allowed = await requireListPermission(req.userId!, connection.list_id, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { name, hostname, port, forceRecord, params, folderId, credentialMode } = req.body;
  // Same validation the create route above applies, for the same
  // reason: 'ad_passthrough' shouldn't be settable via a direct API call
  // on a deployment where AD isn't configured at all, even though the
  // connection form itself only ever offers it once GET /admin/ad-status
  // says it's available.
  if (credentialMode !== undefined && credentialMode !== null) {
    if (!VALID_CREDENTIAL_MODES.has(credentialMode)) {
      return res.status(400).json({ error: 'invalid_credential_mode' });
    }
    if (credentialMode === 'ad_passthrough' && !isAdEnabled()) {
      return res.status(400).json({ error: 'ad_not_configured' });
    }
  }
  // Requested directly: no way existed to change a connection's
  // credential policy (shared vs. individual) after creation at all —
  // only at the moment it was first created, via AddConnectionForm.tsx's
  // own create-time checkbox. Safe to change freely after the fact: the
  // underlying connection_credentials rows for both modes already
  // coexist independently (shared: user_id IS NULL; individual: one row
  // per user), keyed by whether user_id is null, not by this flag — so
  // switching modes never deletes or migrates anything, it just changes
  // which existing (or not-yet-set) row(s) actually get used the next
  // time someone connects. ad_passthrough uses neither at all — see
  // tunnelToken.ts's own issueNewConnectionToken.
  await db.none(
    `UPDATE connections SET name = $1, hostname = $2, port = $3, force_record = $4, params = $5, folder_id = $6,
            credential_mode = COALESCE($7, credential_mode), updated_at = now()
     WHERE id = $8`,
    [name, hostname, port, forceRecord ?? false, JSON.stringify(params ?? {}), folderId || null,
     VALID_CREDENTIAL_MODES.has(credentialMode) ? credentialMode : null, req.params.id]
  );
  await logAuditFromRequest(req, 'connection_updated', { name, hostname }, req.params.id);
  res.json({ status: 'updated' });
});

// Real, standalone folder entities — migration 018 upgraded from the
// flat text column migration 017 originally shipped with. That column
// couldn't represent an empty folder (a folder with zero connections
// assigned) at all, since there was no row for it to exist as; both
// creating a folder before assigning anything to it and assigning a
// connection to a folder via a dropdown, rather than only by editing
// the connection itself, needed this upgrade to be possible.
adminRouter.get('/lists/:listId/folders', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.listId, 'view');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const folders = await db.any(
    `SELECT id, name FROM connection_folders WHERE list_id = $1 ORDER BY name`,
    [req.params.listId]
  );
  res.json({ folders });
});

adminRouter.post('/lists/:listId/folders', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.listId, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { name } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'invalid_input', message: 'name is required.' });
  }
  try {
    const folder = await db.one(
      `INSERT INTO connection_folders (list_id, name) VALUES ($1, $2) RETURNING id, name`,
      [req.params.listId, String(name).trim()]
    );
    await logAuditFromRequest(req, 'folder_created', { listId: req.params.listId, name: folder.name });
    res.json(folder);
  } catch (err: any) {
    // UNIQUE (list_id, name) — a real, expected case (someone typing a
    // folder name that already exists in this list), not a genuine
    // server error, so this gets its own clear response rather than
    // falling through to a generic 500.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'folder_already_exists' });
    }
    throw err;
  }
});

adminRouter.put('/folders/:id', async (req, res) => {
  const folder = await db.oneOrNone(`SELECT list_id FROM connection_folders WHERE id = $1`, [req.params.id]);
  if (!folder) return res.status(404).json({ error: 'not_found' });
  const allowed = await requireListPermission(req.userId!, folder.list_id, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { name } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'invalid_input', message: 'name is required.' });
  }
  try {
    await db.none(`UPDATE connection_folders SET name = $1 WHERE id = $2`, [String(name).trim(), req.params.id]);
    await logAuditFromRequest(req, 'folder_renamed', { folderId: req.params.id, name: String(name).trim() });
    res.json({ status: 'updated' });
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'folder_already_exists' });
    }
    throw err;
  }
});

adminRouter.delete('/folders/:id', async (req, res) => {
  const folder = await db.oneOrNone(`SELECT list_id FROM connection_folders WHERE id = $1`, [req.params.id]);
  if (!folder) return res.status(404).json({ error: 'not_found' });
  const allowed = await requireListPermission(req.userId!, folder.list_id, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  // ON DELETE SET NULL on connections.folder_id (migration 018) — every
  // connection in this folder moves back to the top level, not deleted
  // along with the folder itself. Verified directly against a real
  // running Postgres instance, not just trusted from reading the schema.
  await db.none(`DELETE FROM connection_folders WHERE id = $1`, [req.params.id]);
  await logAuditFromRequest(req, 'folder_deleted', { folderId: req.params.id });
  res.json({ status: 'deleted' });
});

// A dedicated, minimal endpoint specifically for assigning a connection
// to a folder from a dropdown in the connection list view — deliberately
// not reusing PUT /connections/:id for this. That route overwrites the
// entire row, including params; the connections-list response the
// frontend already has doesn't include params at all, so a "quick
// folder assignment" going through the full PUT would have silently
// wiped out any existing advanced parameters (like ignore-cert) on
// every single use. This only ever touches folder_id.
adminRouter.patch('/connections/:id/folder', async (req, res) => {
  const connection = await db.oneOrNone(`SELECT list_id FROM connections WHERE id = $1`, [req.params.id]);
  if (!connection) return res.status(404).json({ error: 'not_found' });
  const allowed = await requireListPermission(req.userId!, connection.list_id, 'edit');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const { folderId } = req.body;
  await db.none(`UPDATE connections SET folder_id = $1, updated_at = now() WHERE id = $2`, [folderId || null, req.params.id]);
  await logAuditFromRequest(req, 'connection_folder_changed', { connectionId: req.params.id, folderId: folderId || null }, req.params.id);
  res.json({ status: 'updated' });
});

// Requested directly: listing existing recordings in the admin view, as a
// first step before deciding on the harder question of who besides an
// admin should be able to view/stream them (the existing
// GET /api/sessions/recordings/:id/stream route has no per-resource
// authorization check at all today — a real, known gap, deliberately
// left untouched here since that's the specific piece being deferred).
// This listing route itself IS gated with the same requireListPermission
// pattern every other admin.ts route already uses, though — that's not
// a new authorization decision being made ahead of schedule, just basic
// consistency with how every other list-scoped admin route in this file
// already works; leaving it wide open to any authenticated user would
// have been the one genuinely new gap here, not a deferred decision.
// 'admin' rather than 'view'/'edit': recordings can capture on-screen
// content from whatever the connection reaches, which is more sensitive
// than the connection's own name/hostname, so this defaults to the same
// permission level list deletion already requires.
//
// INNER JOIN against connections, not LEFT — session_recordings.connection_id
// is nullable (migration 016, ON DELETE SET NULL, so recordings survive a
// deleted connection rather than being destroyed with it) but there's no
// other way to know which list an orphaned recording belonged to once its
// connection is gone, so a recording in that state simply can't appear in
// any per-list view. Worth knowing about, not fixable without a schema
// change adding list_id directly to session_recordings.
adminRouter.get('/lists/:listId/recordings', async (req, res) => {
  const allowed = await requireListPermission(req.userId!, req.params.listId, 'admin');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const recordings = await db.any(
    `SELECT sr.id, sr.session_id, sr.connection_id, c.name AS connection_name, sr.user_id, u.username,
            sr.started_at, sr.ended_at, sr.file_size_bytes, sr.export_status
     FROM session_recordings sr
     JOIN connections c ON c.id = sr.connection_id
     JOIN users u ON u.id = sr.user_id
     WHERE c.list_id = $1
     ORDER BY sr.started_at DESC`,
    [req.params.listId]
  );
  res.json({ recordings });
});

adminRouter.delete('/connections/:id', async (req, res) => {
  // oneOrNone, not one — a connection that's already gone (already
  // deleted, or a stale ID) should surface as a clear 404, not an
  // opaque 500 from db.one() throwing on zero rows. Noticed while
  // investigating the actual reported bug below, and worth fixing while
  // already here rather than leaving a second confusing failure mode
  // sitting right next to the one just fixed.
  const connection = await db.oneOrNone(`SELECT list_id FROM connections WHERE id = $1`, [req.params.id]);
  if (!connection) return res.status(404).json({ error: 'not_found' });
  const allowed = await requireListPermission(req.userId!, connection.list_id, 'admin');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  // Real bug found live: this always failed with a 500 for any
  // connection that had ever actually been used — sessions.connection_id
  // and session_recordings.connection_id were both NOT NULL foreign keys
  // to connections(id) with no ON DELETE behavior specified, defaulting
  // to RESTRICT. Fixed at the schema level (see migration 016) with
  // ON DELETE SET NULL rather than CASCADE, so this DELETE now succeeds
  // while every session, recording, and audit entry that ever referenced
  // this connection is preserved rather than silently destroyed along
  // with it — verified directly against a real PostgreSQL instance
  // running the actual migration sequence, not just read as SQL.
  await db.none(`DELETE FROM connections WHERE id = $1`, [req.params.id]);
  // Real bug found live, reported directly ("gives me an error... but
  // the connection is indeed deleted"): the DELETE above genuinely
  // succeeds — migration 016's ON DELETE SET NULL (see its own comment)
  // correctly handles every *existing* row that referenced this
  // connection. But this audit entry is a brand new INSERT, made after
  // the connection is already gone, still trying to set connection_id to
  // that now-nonexistent id — ON DELETE SET NULL only ever governs
  // existing rows at the moment their parent is deleted, never whether a
  // later, separate INSERT can reference an id that's already gone, so
  // it was never able to help with this specific case at all. That FK
  // violation threw, well after the connection itself was already
  // deleted, so the client saw a failure for a delete that had actually
  // already succeeded. connectionId now goes in `detail` instead — the
  // id itself isn't lost from the audit trail, it's just recorded as
  // data rather than asserted as a still-valid foreign key reference,
  // which is what deleting the row it would have pointed to actually
  // made true.
  await logAuditFromRequest(req, 'connection_deleted', { connectionId: req.params.id }, null);
  res.json({ status: 'deleted' });
});

// Requested directly: exporting/importing connections as a JSON file, for
// backup/restore. Modeled closely on bookmarks.ts's own JSON export/import
// pair (same schema_version envelope, same "skip malformed rows rather
// than fail the whole import" behavior).
//
// Credentials are excluded by default — not an oversight. A connection's
// credential is Vault-encrypted at rest specifically so it's never
// available in plaintext outside Vault; writing it into a portable JSON
// backup file in plaintext would defeat that entirely. Restoring from a
// plain export recreates the connection definitions, but credentials need
// to be re-entered per connection afterward, the same as setting them up
// fresh.
//
// Requested as a follow-up ("without password or with encrypted
// password"): ?includeCredentials=true optionally includes credentials
// too, but still never as plaintext — the raw Vault Transit ciphertext
// already stored in connection_credentials (the exact same
// "vault:v1:..." string the database itself holds, see that table's own
// comment in migration 002) is copied through as an opaque string,
// neither this route nor the import route below ever calls Vault to
// decrypt it. This is genuinely no less secure than the database itself
// already being "vault-ciphertext-readable" at rest, and reads back
// transparently through this app's existing credential-read path on
// import — but only into the SAME Vault instance that originally
// encrypted it (Vault Transit keys are instance-specific); restoring an
// includeCredentials export into a different deployment's Vault will
// import the connections fine but leave their credentials undecryptable
// there, surfacing as the existing "won't connect" status the
// credential-status endpoint already reports for any missing/broken
// credential. Requires 'admin' on the list, not just 'view' — the same
// level credentials.ts's own requiredPermissionForCredentialMode already
// requires to set a shared credential in the first place, so exporting
// one is held to the same bar as writing one.
//
// A connection's OWN credential is included — whichever one actually
// governs it: a 'shared' connection's own shared (user_id IS NULL) row,
// or, for an 'individual' connection, the *exporting user's own* row for
// it specifically — never another person's. Reported directly as a real
// bug in the first version of this feature, which only ever looked for
// the shared row regardless of a connection's own mode: an 'individual'
// connection (the default `credentialMode` in ListDetail's own
// connection-creation form, notably — the same form used for both
// admin-managed shared lists and, via MyListPage.tsx, personal lists)
// would never export a credential at all, even the exporting admin's
// own, genuinely-working one for it. For a personal list specifically —
// where the owner is the only person who could ever have set a
// credential on any of their own connections in the first place — that
// meant "include credentials" silently exported almost nothing, which is
// exactly what got reported. Verified directly against a real database
// across every real case before trusting this: a shared connection's
// shared credential; an individual connection where the exporting user's
// own row exists; the identical individual connection exported instead
// by a genuinely different user, confirming their row is never touched;
// and an individual connection with no credential at all, confirming
// nothing is fabricated. The original protection this feature was built
// to preserve is unchanged, just correctly scoped: nobody's export can
// ever contain a credential belonging to anyone but themselves or the
// list's own shared one.
//
// Folders are exported/imported by name, not by folder_id — an id is
// meaningless once restored into a different list or a rebuilt database
// (a fresh install's folder rows would have entirely new, unrelated ids
// even for a folder of the same name), so importing finds-or-creates a
// folder by name in the target list rather than trying to preserve the
// original id.
adminRouter.get('/lists/:listId/connections/export', async (req, res) => {
  const includeCredentials = req.query.includeCredentials === 'true';
  const requiredLevel = includeCredentials ? 'admin' : 'view';
  const allowed = await requireListPermission(req.userId!, req.params.listId, requiredLevel);
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  const list = await db.one(`SELECT name FROM connection_lists WHERE id = $1`, [req.params.listId]);
  const connections = await db.any(
    includeCredentials
      ? `SELECT c.name, c.protocol, c.hostname, c.port, c.credential_mode, c.force_record, c.params, f.name AS folder_name,
                cred.username_encrypted AS credential_username_encrypted, cred.secret_encrypted AS credential_secret_encrypted
         FROM connections c
         LEFT JOIN connection_folders f ON f.id = c.folder_id
         LEFT JOIN LATERAL (
           SELECT username_encrypted, secret_encrypted
           FROM connection_credentials cc
           WHERE cc.connection_id = c.id
             AND cc.user_id IS NOT DISTINCT FROM (CASE WHEN c.credential_mode = 'individual' THEN $2::uuid ELSE NULL END)
           LIMIT 1
         ) cred ON true
         WHERE c.list_id = $1 ORDER BY f.name NULLS FIRST, c.name`
      : `SELECT c.name, c.protocol, c.hostname, c.port, c.credential_mode, c.force_record, c.params, f.name AS folder_name
         FROM connections c
         LEFT JOIN connection_folders f ON f.id = c.folder_id
         WHERE c.list_id = $1 ORDER BY f.name NULLS FIRST, c.name`,
    includeCredentials ? [req.params.listId, req.userId!] : [req.params.listId]
  );

  if (includeCredentials) {
    await logAuditFromRequest(req, 'connections_exported_json_with_credentials', { listId: req.params.listId });
  }

  res.json({
    schema_version: 1,
    list_name: list.name,
    exported_at: new Date().toISOString(),
    includes_credentials: includeCredentials,
    connections
  });
});

adminRouter.post('/lists/:listId/connections/import', async (req, res) => {
  const { schema_version, connections } = req.body;
  if (schema_version !== 1) return res.status(400).json({ error: 'unsupported_schema_version' });
  if (!Array.isArray(connections)) return res.status(400).json({ error: 'invalid_input', message: 'connections must be an array.' });

  // Checked upfront, against the whole file, rather than per connection
  // as each row happens to be processed below — a single import that
  // silently imported some connections' credentials while skipping
  // others purely because permission ran out partway through would be a
  // confusing, inconsistent result. One clear gate for the entire
  // operation instead: if anything in this file carries a credential,
  // the caller needs 'admin' before any of it is written at all.
  const importIncludesCredentials = connections.some(
    (c: any) => c && typeof c.credential_secret_encrypted === 'string' && typeof c.credential_username_encrypted === 'string'
  );
  const requiredLevel = importIncludesCredentials ? 'admin' : 'edit';
  const allowed = await requireListPermission(req.userId!, req.params.listId, requiredLevel);
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });

  // Cache within this single import so ten connections in the same
  // "linux" folder don't attempt ten separate find-or-create races
  // against the same folder name.
  const folderIdByName = new Map<string, string>();
  async function resolveFolderId(folderName: string | null | undefined): Promise<string | null> {
    if (!folderName) return null;
    if (folderIdByName.has(folderName)) return folderIdByName.get(folderName)!;
    const existing = await db.oneOrNone(
      `SELECT id FROM connection_folders WHERE list_id = $1 AND name = $2`,
      [req.params.listId, folderName]
    );
    const folderId = existing
      ? existing.id
      : (await db.one(
          `INSERT INTO connection_folders (list_id, name) VALUES ($1, $2) RETURNING id`,
          [req.params.listId, folderName]
        )).id;
    folderIdByName.set(folderName, folderId);
    return folderId;
  }

  let imported = 0;
  let importedCredentials = 0;
  for (const c of connections) {
    // Skip malformed entries rather than failing the whole import, same
    // as bookmarks.ts's own import — one bad row in an otherwise-good
    // backup file shouldn't block restoring everything else in it.
    if (!c || typeof c.name !== 'string' || typeof c.protocol !== 'string' || typeof c.hostname !== 'string') continue;
    // An ad_passthrough row imported into a deployment with no AD
    // configured can never actually work here (nothing could ever
    // populate the credential it needs at connect time) — skipped
    // outright rather than silently downgraded to 'shared', which would
    // instead leave it permanently, confusingly failing with
    // no_credentials_configured with no indication why. Same "skip
    // rather than fail the whole import" handling as a malformed row
    // just above, for the same reason: one row that can't be imported
    // here shouldn't block the rest of an otherwise-good file.
    if (c.credential_mode === 'ad_passthrough' && !isAdEnabled()) continue;
    const folderId = await resolveFolderId(c.folder_name);
    const importedMode = VALID_CREDENTIAL_MODES.has(c.credential_mode) ? c.credential_mode : 'shared';
    const newConnection = await db.one(
      `INSERT INTO connections (list_id, name, protocol, hostname, port, credential_mode, force_record, params, folder_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        req.params.listId,
        c.name,
        c.protocol,
        c.hostname,
        c.port ?? null,
        importedMode,
        !!c.force_record,
        JSON.stringify(c.params ?? {}),
        folderId
      ]
    );
    imported++;

    // Copied through exactly as exported — never decrypted, never
    // re-encrypted, the same opaque-ciphertext handling as the export
    // side above. Written back matching the imported connection's own
    // mode, the same way the export side reads it: a shared credential
    // lands with user_id NULL as before, but an individual one is now
    // scoped to whoever is actually running this import — correct,
    // since the export route above only ever exported the exporting
    // user's own individual credential in the first place, never
    // anyone else's, so there's no other user's row this could
    // possibly be attributing here.
    if (typeof c.credential_username_encrypted === 'string' && typeof c.credential_secret_encrypted === 'string') {
      await db.none(
        `INSERT INTO connection_credentials (connection_id, user_id, username_encrypted, secret_encrypted)
         VALUES ($1, $2, $3, $4)`,
        [newConnection.id, importedMode === 'individual' ? req.userId : null, c.credential_username_encrypted, c.credential_secret_encrypted]
      );
      importedCredentials++;
    }
  }
  await logAuditFromRequest(req, 'connections_imported_json', {
    listId: req.params.listId,
    imported,
    importedCredentials
  });
  res.json({ imported, importedCredentials, skipped: connections.length - imported });
});

