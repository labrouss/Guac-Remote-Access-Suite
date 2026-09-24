import { Router } from 'express';
import { db } from '../db';
import { encryptCredential } from '../services/vaultClient';
import { requireListPermission } from '../services/permissions';
import { logAudit } from '../services/auditLog';

export const credentialsRouter = Router();

export type CredentialMode = 'shared' | 'individual';

/**
 * The actual branching logic, extracted so it can be unit tested directly
 * (see credentials.test.ts) — these two decisions are exactly what
 * determines whether a credential write lands scoped to one user or
 * shared across everyone, and a bug in either direction either locks out
 * legitimate users or leaks a credential to the wrong scope.
 */
export function requiredPermissionForCredentialMode(mode: CredentialMode): 'admin' | 'connect' {
  // 'shared' requires 'admin' — a single credential every connect-level
  // user will use, so only someone who can administer the list should be
  // able to set/change it. 'individual' only requires 'connect' — a user
  // should be able to add their own credential without being an admin.
  return mode === 'shared' ? 'admin' : 'connect';
}

export function credentialTargetUserId(mode: CredentialMode, userId: string): string | null {
  // Individual mode scopes the row to the caller specifically. Shared mode
  // MUST use NULL, not the caller's own id — otherwise a shared credential
  // would only ever resolve for whichever user happened to set it, and every
  // other connect-level user's session would silently find "no credentials
  // configured" (see guacTunnel.test.ts's credential-mode branching tests
  // for the read-side query this write path has to stay in sync with).
  return mode === 'individual' ? userId : null;
}

export interface CredentialWriteResult {
  status: 'saved' | 'not_authorized';
}

/**
 * Full logic behind PUT /:connectionId, extracted out of the Express
 * handler (same pattern as guacTunnel.ts's resolveConnectionSettings) so
 * the whole decision sequence — permission gate, target-scope resolution,
 * encryption, upsert, audit log — is directly unit testable without an
 * HTTP layer or a real Postgres/Vault.
 */
export async function writeConnectionCredential(
  userId: string,
  connectionId: string,
  username: string,
  secret: string,
  sourceIp?: string | null
): Promise<CredentialWriteResult> {
  const connection = await db.one(
    `SELECT list_id, credential_mode FROM connections WHERE id = $1`,
    [connectionId]
  );

  const requiredLevel = requiredPermissionForCredentialMode(connection.credential_mode);
  const allowed = await requireListPermission(userId, connection.list_id, requiredLevel);
  if (!allowed) return { status: 'not_authorized' };

  const targetUserId = credentialTargetUserId(connection.credential_mode, userId);

  const usernameEncrypted = await encryptCredential(username);
  const secretEncrypted = await encryptCredential(secret);

  await db.none(
    `INSERT INTO connection_credentials (connection_id, user_id, username_encrypted, secret_encrypted)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (connection_id, user_id)
     DO UPDATE SET username_encrypted = $3, secret_encrypted = $4, updated_at = now()`,
    [connectionId, targetUserId, usernameEncrypted, secretEncrypted]
  );

  await logAudit({
    userId,
    connectionId,
    action: 'credential_updated',
    detail: { mode: connection.credential_mode },
    sourceIp
  });

  return { status: 'saved' };
}

export interface CredentialStatusResult {
  configured: boolean;
  mode: CredentialMode;
}

/**
 * Full logic behind GET /:connectionId/status — lets the frontend show
 * "you still need to add your credentials" without ever returning the
 * credential itself.
 */
export async function getConnectionCredentialStatus(
  userId: string,
  connectionId: string
): Promise<CredentialStatusResult | null> {
  // oneOrNone, not one — matches the same fix just made to the
  // connection DELETE route for the same reason: a connection that no
  // longer exists (deleted, or a stale reference) should surface as a
  // clear "not found" to the caller, not an opaque 500 from db.one()
  // throwing on zero rows.
  const connection = await db.oneOrNone(`SELECT credential_mode FROM connections WHERE id = $1`, [connectionId]);
  if (!connection) return null;
  const targetUserId = credentialTargetUserId(connection.credential_mode, userId);

  const exists = await db.oneOrNone(
    `SELECT 1 FROM connection_credentials WHERE connection_id = $1 AND (user_id = $2 OR ($2 IS NULL AND user_id IS NULL))`,
    [connectionId, targetUserId]
  );
  return { configured: !!exists, mode: connection.credential_mode };
}

credentialsRouter.put('/:connectionId', async (req, res) => {
  const { username, secret } = req.body;
  const result = await writeConnectionCredential(req.userId!, req.params.connectionId, username, secret, req.ip);
  if (result.status === 'not_authorized') return res.status(403).json({ error: 'not_authorized' });
  res.json(result);
});

credentialsRouter.get('/:connectionId/status', async (req, res) => {
  const result = await getConnectionCredentialStatus(req.userId!, req.params.connectionId);
  if (!result) return res.status(404).json({ error: 'not_found' });
  res.json(result);
});
