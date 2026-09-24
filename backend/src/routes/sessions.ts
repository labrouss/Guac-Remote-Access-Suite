import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { db } from '../db';
import { toggleRecording, disconnectJoinedUser } from '../services/guacTunnel';
import { queueVideoExport } from '../services/videoExportQueue';
import { pushFileViaSftp } from '../services/sshFileTransfer';
import * as rdpDrive from '../services/rdpDriveManager';
import { hasConnectionAccess, canAccessRecording } from '../services/permissions';
import { logAuditFromRequest, logAudit } from '../services/auditLog';
import { encryptGuacToken } from '../services/guacToken';

export const sessionsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB paste-file ceiling

async function getActiveSession(connectionId: string, userId: string) {
  return db.oneOrNone(
    `SELECT id, rdp_drive_id FROM sessions
     WHERE connection_id = $1 AND owner_user_id = $2 AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [connectionId, userId]
  );
}

// Lets the frontend recover the real backend `sessions.id` for the
// connection it just opened — SessionViewport only knows connectionId
// until it calls this, once connected. Needed for both the record button
// (routes below are keyed by sessions.id, not connectionId) and for
// sharing a live session with someone else.
sessionsRouter.get('/:connectionId/active', async (req, res) => {
  const session = await getActiveSession(req.params.connectionId, req.userId!);
  if (!session) return res.status(404).json({ error: 'no_active_session' });
  res.json({ sessionId: session.id });
});

// Paste-a-file-into-a-session: frontend detects a file in the clipboard on
// paste and posts it here. SSH sessions push over SFTP; RDP sessions drop
// the file straight into that session's mounted drive-redirection folder.
sessionsRouter.post('/:connectionId/paste-file', upload.single('file'), async (req, res) => {
  const connection = await db.oneOrNone(`SELECT list_id, protocol FROM connections WHERE id = $1`, [req.params.connectionId]);
  if (!connection) return res.status(404).json({ error: 'connection_not_found' });

  const allowed = await hasConnectionAccess(req.userId!, req.params.connectionId, 'connect');
  if (!allowed) return res.status(403).json({ error: 'not_authorized' });
  if (!req.file) return res.status(400).json({ error: 'no_file' });

  try {
    let remotePath: string;

    if (connection.protocol === 'ssh') {
      remotePath = await pushFileViaSftp(req.params.connectionId, req.userId!, req.file.buffer, req.file.originalname);
    } else if (connection.protocol === 'rdp') {
      const session = await getActiveSession(req.params.connectionId, req.userId!);
      if (!session?.rdp_drive_id) return res.status(409).json({ error: 'no_active_rdp_session' });

      // Mark known *before* writing so the folder watcher doesn't treat our
      // own write as a new file arriving from the Windows side.
      rdpDrive.markKnown(session.rdp_drive_id, req.file.originalname);
      const drivePath = rdpDrive.getDrivePath(session.rdp_drive_id)!;
      fs.writeFileSync(path.join(drivePath, req.file.originalname), req.file.buffer);
      // Surfaced to the user as "open the Guacamole Transfer folder on the
      // desktop" rather than a literal path, since there's no terminal
      // cursor to type into for RDP the way there is for SSH.
      remotePath = `Guacamole Transfer\\${req.file.originalname}`;
    } else {
      return res.status(400).json({ error: 'file_paste_not_supported_for_protocol' });
    }

    await logAuditFromRequest(
      req,
      'file_transfer',
      { direction: 'upload', filename: req.file.originalname, size: req.file.size },
      req.params.connectionId
    );
    res.json({ remotePath });
  } catch (err) {
    res.status(500).json({ error: 'transfer_failed', message: (err as Error).message });
  }
});

// Polled by the frontend for RDP sessions: surfaces files the user dragged
// into the "Guacamole Transfer" drive from inside the remote Windows session,
// so they can be offered as a normal browser download.
sessionsRouter.get('/:connectionId/rdp-downloads', async (req, res) => {
  const session = await getActiveSession(req.params.connectionId, req.userId!);
  if (!session?.rdp_drive_id) return res.json({ files: [] });

  const filenames = rdpDrive.takePendingDownloads(session.rdp_drive_id);
  res.json({
    files: filenames.map((name) => ({
      name,
      downloadUrl: `/api/sessions/rdp-drive/${session.rdp_drive_id}/download/${encodeURIComponent(name)}`
    }))
  });
});

sessionsRouter.get('/rdp-drive/:rdpDriveId/download/:filename', async (req, res) => {
  const drivePath = rdpDrive.getDrivePath(req.params.rdpDriveId);
  if (!drivePath) return res.status(404).end();

  const filePath = path.join(drivePath, req.params.filename);
  // Guard against path traversal — resolved path must stay inside the drive folder.
  if (!filePath.startsWith(drivePath)) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();

  await logAuditFromRequest(req, 'file_transfer', { direction: 'download', filename: req.params.filename });

  res.download(filePath, req.params.filename);
});

// Record button: start/stop, toggled instantly since it taps the live
// instruction stream rather than reconnecting with a different guacd parameter.
sessionsRouter.post('/:sessionId/record', async (req, res) => {
  const { action } = req.body; // 'start' | 'stop'
  const session = await db.oneOrNone(`SELECT owner_user_id FROM sessions WHERE id = $1`, [req.params.sessionId]);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (session.owner_user_id !== req.userId) {
    return res.status(403).json({ error: 'only_owner_can_record' });
  }

  try {
    const result = await toggleRecording(req.params.sessionId, req.userId!, action, req.ip);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Byte-range aware stream of the raw .guac recording, consumed by
// Guacamole.SessionRecording in the frontend player.
//
// Real gap found live, fixed here: this had no authorization check at
// all before — any authenticated user with a recording's UUID could
// stream it regardless of permission on the underlying connection.
// Policy given directly: an admin or the recording's own creator, and
// no one else. See canAccessRecording's own comment in permissions.ts
// for why the creator check has to come before (and independently of)
// the connection lookup — a recording survives its connection being
// deleted, and the creator's access shouldn't disappear along with it.
sessionsRouter.get('/recordings/:id/stream', async (req, res) => {
  const rec = await db.oneOrNone(`SELECT * FROM session_recordings WHERE id = $1`, [req.params.id]);
  if (!rec) return res.status(404).end();
  if (!(await canAccessRecording(req.userId!, req.params.id))) return res.status(403).end();

  const stat = fs.statSync(rec.file_path);
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'application/octet-stream' });
    return fs.createReadStream(rec.file_path).pipe(res);
  }

  const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(startStr, 10);
  const end = endStr ? parseInt(endStr, 10) : stat.size - 1;

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'application/octet-stream'
  });
  fs.createReadStream(rec.file_path, { start, end }).pipe(res);
});

sessionsRouter.post('/recordings/:id/export', async (req, res) => {
  const rec = await db.oneOrNone(`SELECT id FROM session_recordings WHERE id = $1`, [req.params.id]);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  if (!(await canAccessRecording(req.userId!, req.params.id))) return res.status(403).json({ error: 'not_authorized' });
  await queueVideoExport(rec.id);
  res.json({ status: 'queued' });
});

sessionsRouter.get('/recordings/:id/status', async (req, res) => {
  const rec = await db.oneOrNone(
    `SELECT export_status, video_path FROM session_recordings WHERE id = $1`,
    [req.params.id]
  );
  if (!rec) return res.status(404).json({ error: 'not_found' });
  if (!(await canAccessRecording(req.userId!, req.params.id))) return res.status(403).json({ error: 'not_authorized' });
  res.json(rec);
});

// New — requested directly alongside the authorization policy above.
// Removes the DB row and the underlying .guac (and exported video, if
// one exists) file from disk. Same access policy as the routes above:
// admin or the recording's own creator, no one else.
sessionsRouter.delete('/recordings/:id', async (req, res) => {
  const rec = await db.oneOrNone(`SELECT file_path, video_path FROM session_recordings WHERE id = $1`, [req.params.id]);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  if (!(await canAccessRecording(req.userId!, req.params.id))) return res.status(403).json({ error: 'not_authorized' });

  await db.none(`DELETE FROM session_recordings WHERE id = $1`, [req.params.id]);
  // File removal is best-effort and happens after the DB row is already
  // gone — a missing file on disk (already cleaned up some other way)
  // shouldn't block the delete the person actually asked for, or leave
  // the DB row and the file in a permanently disagreeing state if this
  // fails partway.
  for (const p of [rec.file_path, rec.video_path]) {
    if (p) fs.unlink(p, () => {});
  }
  await logAuditFromRequest(req, 'recording_deleted', { recordingId: req.params.id });
  res.json({ status: 'deleted' });
});

// --- Live session sharing (co-viewing/co-control) ---

// Grant a specific user access to co-view/co-control THIS specific active
// session — independent of whatever list/connect permission they do or
// don't have on the underlying connection (same philosophy as demos: a
// share is its own grant, not contingent on broader RBAC). Only the
// session owner can grant; ephemeral by nature, since it's tied to one
// specific active session instance, not a standing permission for future
// sessions on the same connection (cascades away with the session row).
sessionsRouter.post('/:sessionId/share', async (req, res) => {
  const { userId, role } = req.body;
  if (!['viewer', 'interactive'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role' });
  }

  const session = await db.oneOrNone(
    `SELECT owner_user_id FROM sessions WHERE id = $1 AND ended_at IS NULL`,
    [req.params.sessionId]
  );
  if (!session) return res.status(404).json({ error: 'session_not_found_or_ended' });
  if (session.owner_user_id !== req.userId) return res.status(403).json({ error: 'only_owner_can_share' });

  await db.none(
    `INSERT INTO session_shares (session_id, granted_to_user_id, granted_by_user_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id, granted_to_user_id) DO UPDATE SET role = $4`,
    [req.params.sessionId, userId, req.userId, role]
  );
  await logAuditFromRequest(req, 'session_share_granted', { sessionId: req.params.sessionId, grantedToUserId: userId, role });
  res.json({ status: 'granted' });
});

sessionsRouter.delete('/:sessionId/share/:userId', async (req, res) => {
  const session = await db.oneOrNone(`SELECT owner_user_id FROM sessions WHERE id = $1`, [req.params.sessionId]);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (session.owner_user_id !== req.userId) return res.status(403).json({ error: 'only_owner_can_share' });

  await db.none(
    `DELETE FROM session_shares WHERE session_id = $1 AND granted_to_user_id = $2`,
    [req.params.sessionId, req.params.userId]
  );
  // Requested directly: revoking someone's share previously only removed
  // the grant itself, leaving that person's own already-open connection
  // (if they had one) running with no idea anything changed — they'd
  // keep watching/interacting until they happened to close the tab
  // themselves. This reaches out and closes their live connection
  // directly, the same moment the grant itself is removed, rather than
  // waiting for them to notice on their own.
  disconnectJoinedUser(req.params.sessionId, req.params.userId);
  await logAuditFromRequest(req, 'session_share_revoked', { sessionId: req.params.sessionId, revokedUserId: req.params.userId });
  res.json({ status: 'revoked' });
});

// Every active grant on a session the caller owns, so the frontend can show
// and revoke them individually.
sessionsRouter.get('/:sessionId/shares', async (req, res) => {
  const session = await db.oneOrNone(`SELECT owner_user_id FROM sessions WHERE id = $1`, [req.params.sessionId]);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (session.owner_user_id !== req.userId) return res.status(403).json({ error: 'only_owner_can_view_shares' });

  const shares = await db.any(
    `SELECT ss.granted_to_user_id, u.username, ss.role, ss.created_at
     FROM session_shares ss JOIN users u ON u.id = ss.granted_to_user_id
     WHERE ss.session_id = $1 ORDER BY u.username`,
    [req.params.sessionId]
  );
  res.json(shares);
});

// Active sessions someone else has shared with the caller, for the
// frontend's "shared with you" list.
sessionsRouter.get('/shared-with-me', async (req, res) => {
  const rows = await db.any(
    `SELECT s.id AS session_id, s.connection_id, c.name AS connection_name, c.protocol,
            u.username AS owner_username, ss.role
     FROM session_shares ss
       JOIN sessions s ON s.id = ss.session_id
       JOIN connections c ON c.id = s.connection_id
       JOIN users u ON u.id = s.owner_user_id
     WHERE ss.granted_to_user_id = $1 AND s.ended_at IS NULL
     ORDER BY s.started_at DESC`,
    [req.userId]
  );
  res.json(rows);
});

export type JoinTokenResult =
  | { status: 'session_not_found_or_ended' }
  | { status: 'not_authorized' }
  | { status: 'session_not_ready_yet' }
  | { status: 'ok'; token: string; joinRole: string };

/**
 * Full authorization + token-construction logic for joining an
 * already-active session, extracted out of the Express handler for direct
 * unit testing — same pattern as issueNewConnectionToken in
 * routes/tunnelToken.ts, and for the same reason: this is where the actual
 * decision happens, since guacamole-lite's own callback can no longer do
 * real async authorization work safely (see guacTunnel.ts).
 */
export async function issueJoinToken(
  userId: string,
  sessionId: string,
  readOnly: boolean
): Promise<JoinTokenResult> {
  const session = await db.oneOrNone(
    `SELECT owner_user_id, guacd_connection_id FROM sessions WHERE id = $1 AND ended_at IS NULL`,
    [sessionId]
  );
  if (!session) return { status: 'session_not_found_or_ended' };

  const isOwner = session.owner_user_id === userId;
  const share = isOwner
    ? null
    : await db.oneOrNone(
        `SELECT role FROM session_shares WHERE session_id = $1 AND granted_to_user_id = $2`,
        [sessionId, userId]
      );
  if (!isOwner && !share) return { status: 'not_authorized' };

  if (!session.guacd_connection_id) {
    // Narrow race: joining in the instant between the owner's guacd
    // handshake starting and guacd's `ready` instruction actually arriving.
    return { status: 'session_not_ready_yet' };
  }

  const joinRole = isOwner ? 'owner' : share!.role;
  const token = encryptGuacToken({
    userId,
    joinSessionId: sessionId,
    joinRole,
    issuedAt: Date.now(),
    connection: {
      join: session.guacd_connection_id,
      settings: { 'read-only': readOnly === true }
    }
  });

  return { status: 'ok', token, joinRole };
}

sessionsRouter.post('/:sessionId/join-token', async (req, res) => {
  const result = await issueJoinToken(req.userId!, req.params.sessionId, req.body.readOnly === true);

  if (result.status === 'session_not_found_or_ended') return res.status(404).json({ error: result.status });
  if (result.status === 'not_authorized') return res.status(403).json({ error: result.status });
  if (result.status === 'session_not_ready_yet') return res.status(409).json({ error: result.status });

  await logAudit({
    userId: req.userId!,
    action: 'session_joined',
    detail: { sessionId: req.params.sessionId, readOnly: req.body.readOnly === true },
    sourceIp: req.ip
  });

  res.json({ token: result.token });
});
