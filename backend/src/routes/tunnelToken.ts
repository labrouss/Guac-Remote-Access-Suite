import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db';
import { hasConnectionAccess, isAdministrator } from '../services/permissions';
import { decryptCredential } from '../services/vaultClient';
import { getAdPassthroughCredential } from '../services/activeDirectory';
import * as rdpDrive from '../services/rdpDriveManager';
import { encryptGuacToken } from '../services/guacToken';
import { logAuditFromRequest } from '../services/auditLog';

export const tunnelTokenRouter = Router();

const ADHOC_ALLOWED_PROTOCOLS = new Set(['rdp', 'ssh', 'vnc']);

export type AdhocConnectionTokenResult =
  | { status: 'not_authorized' }
  | { status: 'invalid_input'; message: string }
  | { status: 'ok'; token: string };

/**
 * Requested directly: an ad-hoc connection — fill in host/credentials
 * directly and connect immediately, without first saving a reusable
 * connection record at all. Deliberately admin-only (checked here, not
 * just hidden in the UI — a client-side-only gate is never enough on its
 * own): every other connection in this app is reachable only because an
 * admin explicitly granted it through the list-based permission model,
 * and an ad-hoc connection has no saved record to check permissions
 * against at all — anyone allowed to use this could reach any
 * network-reachable host directly, regardless of what they'd normally
 * be permitted to open. Admins already have exactly that same reach
 * today, just through the slower path of first saving a real connection
 * — this doesn't grant new access, only a faster way to use access that
 * already exists.
 *
 * Deliberately never touches connection_credentials or Vault at all —
 * unlike a saved connection's credentials, which persist there long
 * term, these exist only for the moment it takes to build this one
 * token: in the request body in transit, inside the encrypted token
 * itself, and in memory here while that token is constructed. More
 * ephemeral than a saved connection's credentials, not less secure.
 *
 * connectionId is null throughout the resulting token's payload — every
 * downstream consumer of that field (guacTunnel.ts's own 'open' handler
 * chief among them) already needed to treat a null connectionId as
 * "this session has no saved connection to look anything up from" for
 * this to work at all; see that file's own comments for exactly where.
 */
export async function issueAdhocConnectionToken(
  userId: string,
  input: { protocol?: string; hostname?: string; port?: number; username?: string; password?: string; params?: Record<string, unknown> }
): Promise<AdhocConnectionTokenResult> {
  if (!(await isAdministrator(userId))) return { status: 'not_authorized' };

  const protocol = String(input.protocol ?? '').toLowerCase();
  if (!ADHOC_ALLOWED_PROTOCOLS.has(protocol)) {
    return { status: 'invalid_input', message: 'protocol must be one of: rdp, ssh, vnc' };
  }
  const hostname = String(input.hostname ?? '').trim();
  if (!hostname) return { status: 'invalid_input', message: 'hostname is required' };
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: 'invalid_input', message: 'port must be an integer between 1 and 65535' };
  }
  const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params) ? input.params : {};

  let extraParams: Record<string, any> = { ...params };
  let rdpDriveId: string | null = null;

  // Same drive-redirection auto-mount as a saved RDP connection gets
  // (see issueNewConnectionToken above) — doesn't depend on a saved
  // connection row existing at all, so there's no reason an ad-hoc RDP
  // session should lose paste/drag file transfer just for being ad-hoc.
  if (protocol === 'rdp') {
    rdpDriveId = uuidv4();
    const drivePath = rdpDrive.createDrive(rdpDriveId);
    extraParams = {
      ...extraParams,
      'enable-drive': true,
      'create-drive-path': true,
      'drive-name': 'Guacamole Transfer',
      'drive-path': drivePath
    };
  }

  const token = encryptGuacToken({
    userId,
    connectionId: null,
    rdpDriveId,
    issuedAt: Date.now(),
    connection: {
      type: protocol,
      settings: {
        hostname,
        port,
        username: input.username ?? '',
        password: input.password ?? '',
        ...extraParams
      }
    }
  });

  return { status: 'ok', token };
}

export type NewConnectionTokenResult =
  | { status: 'connection_not_found' }
  | { status: 'not_authorized' }
  | { status: 'no_credentials_configured' }
  | { status: 'ad_credential_unavailable' }
  | { status: 'ok'; token: string };

/**
 * The full authorization + credential-decryption + token-construction
 * logic for opening a brand-new connection, extracted out of the Express
 * handler (same pattern as guacTunnel.ts's earlier resolveConnectionSettings,
 * routes/credentials.ts, routes/demos.ts) so it's directly unit testable.
 *
 * IMPORTANT ARCHITECTURAL NOTE, found empirically while adding live session
 * sharing (upgrading guacamole-lite 0.6.0 -> 1.2.0 to get join support):
 * this function — not guacamole-lite's processConnectionSettings callback in
 * services/guacTunnel.ts — is where this work happens, and the token it
 * returns carries a FULLY resolved `connection` object. This used to be
 * split the other way (a token with only { userId, connectionId }, with the
 * real work done async inside the guacamole-lite callback) — verified
 * directly against the installed 1.2.0 source that this doesn't actually
 * work: guacd's client is constructed from a synchronous snapshot of
 * connection settings taken *before* an async callback (one that does real
 * `await` work, like this) can resolve. Real async authorization work
 * inside that callback silently never reaches guacd at all. Doing it here
 * instead — a normal async/await-friendly code path — sidesteps the race
 * entirely rather than trying to work around it.
 */
export async function issueNewConnectionToken(
  userId: string,
  connectionId: string
): Promise<NewConnectionTokenResult> {
  const connection = await db.oneOrNone(`SELECT * FROM connections WHERE id = $1`, [connectionId]);
  if (!connection) return { status: 'connection_not_found' };

  const allowed = await hasConnectionAccess(userId, connectionId, 'connect');
  if (!allowed) return { status: 'not_authorized' };

  let username: string;
  let password: string;

  if (connection.credential_mode === 'ad_passthrough') {
    // Whatever this same user's own most recent AD login captured
    // (services/activeDirectory.ts) — nothing stored against this
    // connection at all, unlike 'shared'/'individual' below. A distinct
    // status from 'no_credentials_configured': this isn't a connection
    // an admin forgot to finish setting up, it's this user's own AD
    // session having gone stale (or never existed — a local account
    // opening an ad_passthrough connection has nothing here to find,
    // ever, by design) — different enough situations that the route
    // handler below gives each its own message rather than one generic
    // "not configured" for both.
    const adCred = await getAdPassthroughCredential(userId);
    if (!adCred) return { status: 'ad_credential_unavailable' };
    username = adCred.username;
    password = adCred.password;
  } else {
    const credRow = await db.oneOrNone(
      `SELECT username_encrypted, secret_encrypted FROM connection_credentials
       WHERE connection_id = $1 AND (user_id = $2 OR user_id IS NULL)
       ORDER BY user_id NULLS LAST LIMIT 1`,
      [connectionId, connection.credential_mode === 'individual' ? userId : null]
    );
    if (!credRow) return { status: 'no_credentials_configured' };
    username = await decryptCredential(credRow.username_encrypted);
    password = await decryptCredential(credRow.secret_encrypted);
  }

  let extraParams: Record<string, any> = { ...connection.params };
  let rdpDriveId: string | null = null;

  // RDP: auto-mount a per-session drive-redirection folder on every
  // connect, no toggle — this is what backs the "paste a file" and "drag a
  // file out" flows for RDP sessions. See services/rdpDriveManager.ts.
  if (connection.protocol === 'rdp') {
    rdpDriveId = uuidv4();
    const drivePath = rdpDrive.createDrive(rdpDriveId);
    extraParams = {
      ...extraParams,
      'enable-drive': true,
      'create-drive-path': true,
      'drive-name': 'Guacamole Transfer',
      'drive-path': drivePath
    };
  }

  const token = encryptGuacToken({
    userId,
    connectionId,
    rdpDriveId,
    issuedAt: Date.now(),
    connection: {
      type: connection.protocol,
      settings: {
        hostname: connection.hostname,
        port: connection.port,
        username,
        password,
        ...extraParams
      }
    }
  });

  return { status: 'ok', token };
}

// Registered before the /:connectionId wildcard below, deliberately —
// Express matches routes in registration order, and /:connectionId would
// otherwise swallow "adhoc" as its own connectionId value before this
// route ever got a chance to match at all.
tunnelTokenRouter.post('/adhoc', async (req, res) => {
  const result = await issueAdhocConnectionToken(req.userId!, req.body ?? {});

  if (result.status === 'not_authorized') return res.status(403).json({ error: result.status });
  if (result.status === 'invalid_input') return res.status(400).json({ error: result.status, message: result.message });

  // Deliberately logs only the target, never the credentials — same
  // discipline as the 'connect' audit entry for a saved connection just
  // below, which also never logs credentials.
  await logAuditFromRequest(req, 'adhoc_connect', {
    protocol: req.body?.protocol,
    hostname: req.body?.hostname,
    port: req.body?.port
  });

  res.json({ token: result.token });
});

tunnelTokenRouter.post('/:connectionId', async (req, res) => {
  const result = await issueNewConnectionToken(req.userId!, req.params.connectionId);

  if (result.status === 'connection_not_found') return res.status(404).json({ error: result.status });
  if (result.status === 'not_authorized') return res.status(403).json({ error: result.status });
  if (result.status === 'no_credentials_configured') return res.status(409).json({ error: result.status });
  if (result.status === 'ad_credential_unavailable') return res.status(409).json({ error: result.status });

  // Has real req.ip available — an improvement over the previous location
  // of this log entry (inside the guacamole-lite callback, which has no
  // HTTP request context at all).
  await logAuditFromRequest(req, 'connect', {}, req.params.connectionId);

  res.json({ token: result.token });
});
