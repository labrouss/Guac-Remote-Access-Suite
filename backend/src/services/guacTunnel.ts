import GuacamoleLite from 'guacamole-lite';
import { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db';
import * as rdpDrive from './rdpDriveManager';
import { logAudit } from './auditLog';
import { logger } from './logger';
import { deriveGuacTokenKey } from './guacTokenKey';
import { SizeInstructionTracker } from './sizeInstructionTracker';

const RECORDINGS_PATH = process.env.RECORDINGS_PATH || '/data/recordings';
const TOKEN_MAX_AGE_MS = 30_000; // generous — the frontend uses a token within a second or two of issuing it

/**
 * Per-active-session recorder. Taps the guacd -> browser instruction stream
 * at this proxy layer (rather than using guacd's own recording-path parameter)
 * so recording can be toggled on/off mid-session without a reconnect.
 *
 * Only the session OWNER's own guacdClient is ever tapped — a joiner (see
 * "Live session sharing" below) gets their own separate guacd protocol
 * stream from guacd's perspective, but it mirrors the same remote display
 * the owner already sees (including changes driven by an interactive
 * joiner's own input, which guacd broadcasts back through every connected
 * client's stream). Tapping the joiner's stream too would just duplicate
 * the same recording, not capture anything additional.
 */
class SessionRecorder {
  private writeStream: fs.WriteStream | null = null;
  public recordingId: string | null = null;
  private startedAt: Date | null = null;
  private filePath: string | null = null;

  constructor(private sessionId: string, private connectionId: string | null, private userId: string) {}

  start(seedSizeInstruction?: string | null) {
    this.recordingId = uuidv4();
    const dir = path.join(RECORDINGS_PATH, this.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, `${this.recordingId}.guac`);
    this.writeStream = fs.createWriteStream(this.filePath);
    this.startedAt = new Date();

    // Seeds the new recording with the most recently known display size,
    // if one is available — see SizeInstructionTracker's own comment for
    // the full reasoning. Written before any live instruction has a
    // chance to reach this stream, so playback always has a real size to
    // initialize the display from, even for a recording that starts
    // mid-session, long after guacd's own original "size" instruction
    // was sent and gone.
    if (seedSizeInstruction) this.writeStream.write(seedSizeInstruction);

    return db.none(
      `INSERT INTO session_recordings (id, session_id, connection_id, user_id, file_path, started_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [this.recordingId, this.sessionId, this.connectionId, this.userId, this.filePath, this.startedAt]
    );
  }

  write(instruction: string) {
    this.writeStream?.write(instruction);
  }

  async stop() {
    if (!this.writeStream || !this.recordingId) return;

    // Wait for the stream to actually finish flushing before statting the
    // file — without this, file_size_bytes would race the final write and
    // sometimes record a size from just before the last chunk landed.
    await new Promise<void>((resolve) => this.writeStream!.end(resolve));

    const fileSizeBytes = this.filePath && fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : null;

    await db.none(
      `UPDATE session_recordings SET ended_at = now(), file_size_bytes = $1 WHERE id = $2`,
      [fileSizeBytes, this.recordingId]
    );
    this.writeStream = null;
  }

  get isRecording() {
    return this.writeStream !== null;
  }
}

// sessionId -> recorder, so the record-toggle HTTP route can reach the right instance
export const activeRecorders = new Map<string, SessionRecorder>();
// sessionId -> tracker, so toggleRecording (a separate HTTP route
// handler, not the same closure that creates the tracker at session
// open) can reach the right session's most recently known size when a
// mid-session recording start needs seeding — see SizeInstructionTracker
// and SessionRecorder.start()'s own comments for the full reasoning.
export const activeSizeTrackers = new Map<string, SizeInstructionTracker>();
// sessionId -> (userId -> clientConnection) for every currently-joined
// participant's own live guacamole-lite connection. Built specifically
// so a share revocation or the owner ending their session can reach
// out and forcibly close a joined participant's own connection from
// this side, on demand — see disconnectJoinedUser/disconnectAllJoined
// below and their real callers (routes/sessions.ts's revoke route, and
// this same file's own 'close' handler for the owner). Not previously
// relied upon at all: the owner's own connection ending was assumed to
// be sufficient by itself, on the theory that guacd drops every joined
// client along with the primary connection automatically — reported
// live as not reliably true in practice (a joined participant's own
// session was observed remaining open after the owner stopped theirs),
// so this makes the disconnect explicit and direct from this side
// instead of depending on that assumption holding.
export const activeJoinedConnections = new Map<string, Map<string, any>>();

/**
 * Forcibly closes one specific joined participant's own live connection,
 * if they currently have one open — used when the session owner revokes
 * that specific person's share. A no-op, not an error, if they aren't
 * currently connected at all (the share row itself is still deleted by
 * the caller regardless; this only handles an already-live connection).
 */
export function disconnectJoinedUser(sessionId: string, userId: string) {
  const clientConnection = activeJoinedConnections.get(sessionId)?.get(userId);
  clientConnection?.close();
}

/**
 * Forcibly closes every currently-joined participant's own live
 * connection for a session — used when the session owner's own
 * connection ends, so every joined viewer/interactive participant is
 * reliably disconnected too, rather than depending on guacd's own
 * cross-client teardown behavior (see this map's own comment above for
 * why that alone wasn't reliable enough in practice).
 */
export function disconnectAllJoined(sessionId: string) {
  const joined = activeJoinedConnections.get(sessionId);
  if (!joined) return;
  for (const clientConnection of joined.values()) clientConnection.close();
  activeJoinedConnections.delete(sessionId);
}

/**
 * The guacamole-lite processConnectionSettings callback — deliberately
 * reduced to a synchronous, no-real-work pass-through. This is a direct
 * consequence of an empirically-verified finding (see routes/tunnelToken.ts
 * and routes/sessions.ts's join-token route for the full explanation):
 * guacd's client is constructed from a synchronous snapshot of connection
 * settings taken before any genuinely async work in this callback can
 * resolve, so authorization/credential-decryption/RDP-drive-setup have all
 * moved to the token-issuance HTTP routes instead, which are properly
 * async/await-safe. By the time this callback runs, `settings.connection`
 * is already fully resolved and ready for guacd.
 *
 * The one check kept here is deliberately synchronous — a token-freshness
 * check needs no database or network access, so it doesn't suffer from the
 * same race. Anything requiring real I/O must not live in this callback.
 */
function passThroughConnectionSettings(settings: any, callback: (err: Error | null, settings: any) => void) {
  if (typeof settings.issuedAt === 'number' && Date.now() - settings.issuedAt > TOKEN_MAX_AGE_MS) {
    return callback(new Error('token_expired'), null);
  }
  callback(null, settings);
}

export function attachGuacTunnel(httpServer: Server) {
  const guacdOptions = {
    host: process.env.GUACD_HOST,
    port: Number(process.env.GUACD_PORT ?? 4822)
  };

  const clientOptions = {
    crypt: {
      cypher: 'AES-256-CBC',
      // deriveGuacTokenKey() (a Buffer), not the raw env var string — a
      // real, confirmed bug found via a live deployment: guacamole-lite's
      // own Crypt class does zero transformation of whatever key it's
      // given here (verified by reading its real source directly), so
      // this needs to be the *exact* same 32 bytes encryptGuacToken.ts
      // uses to encrypt, not just "whatever's in the env var" — see that
      // helper's own comment for the full story. Passing a Buffer
      // directly here also avoids any ambiguity in how Node's crypto
      // would otherwise need to interpret a raw string's encoding.
      key: deriveGuacTokenKey()
    }
  };

  const callbacks = {
    processConnectionSettings: passThroughConnectionSettings
    // sessionRegistry deliberately not configured — the default in-memory
    // Map is correct for this app's default single-backend-replica
    // deployment. Joining across two different backend containers behind a
    // load balancer would need a shared registry (e.g. Redis-backed)
    // instead — a known limitation, not solved here, since horizontal
    // scaling isn't this app's default deployment shape.
  };

  const guacServer = new GuacamoleLite({ server: httpServer }, guacdOptions, clientOptions, callbacks);

  // NOTE ON API VERSION: guacamole-lite's event surface changed between
  // 0.6.x (this app's previous pin) and 1.x — 0.6.x exposed a `connection`
  // event with per-connection `ready`/`close` sub-events; 1.x instead emits
  // top-level `open`/`close`/`error` directly on the server, confirmed by
  // reading the real installed 1.2.0 source rather than assumed from
  // changelog prose.
  guacServer.on('open', async (clientConnection: any) => {
    // Wrapped in try/catch deliberately — this is a plain EventEmitter
    // callback, not an Express route, so express-async-errors (see
    // app.ts) does nothing for it: an unhandled rejection here crashes
    // the entire Node process exactly the same way the bug described in
    // app.ts's own comment did, just via a different code path. One
    // failed session shouldn't be able to take down every other
    // concurrent user's connection.
    try {
      const { userId, connectionId, rdpDriveId, joinSessionId, joinRole } = clientConnection.connectionSettings;

      if (joinSessionId) {
        // A joiner's connection — record it in the join/leave ledger against
        // the EXISTING session row; no new `sessions` row, no new recorder
        // (see the SessionRecorder class comment on why). `joinRole` was
        // already resolved once at join-token issuance (routes/sessions.ts).
        await db.none(
          `INSERT INTO session_participants (session_id, user_id, role) VALUES ($1, $2, $3)`,
          [joinSessionId, userId, joinRole ?? 'viewer']
        );
        // Tracked here so a share revocation or the owner ending their
        // own session can reach this exact connection later and close
        // it directly — see activeJoinedConnections' own comment.
        if (!activeJoinedConnections.has(joinSessionId)) {
          activeJoinedConnections.set(joinSessionId, new Map());
        }
        activeJoinedConnections.get(joinSessionId)!.set(userId, clientConnection);
        return;
      }

      const sessionId = uuidv4();
      // guacamoleConnectionId (not connectionId!) is the real guacd-assigned
      // id usable for a future `join` — verified directly against the
      // installed 1.2.0 source for exactly when this becomes reliably
      // populated (see the ambient type declaration's comment). An earlier
      // version of this code stored `clientConnection.connectionId` here
      // instead (guacamole-lite's own internal per-websocket counter), which
      // would have made every stored guacd_connection_id useless for its
      // stated purpose — caught while building live session sharing.

      // Real, separate bug found live while chasing the recording-playback
      // one: the guacdClient 'data' listener used to only get attached
      // after several awaited db.none() calls below (the sessions row,
      // the session_participants row) — the 'open' event firing means
      // guacd's own connection is already live and could start emitting
      // data immediately, well before those awaits ever resolve. Any
      // instruction arriving in that window — potentially including the
      // one "size" instruction the whole recording-visibility fix in this
      // file depends on — was silently lost entirely, with nothing
      // listening yet to ever see it. sessionId/recorder/sizeTracker only
      // need synchronous construction, so this attaches the listener
      // immediately, before any async work at all, closing that window
      // completely rather than narrowing it. recorder.write() and
      // sizeTracker.feed() are both already safe to call before
      // recorder.start() has ever run — write() is a harmless no-op until
      // a real write stream exists, and the tracker is fully independent
      // of recording state to begin with — so nothing below needs to
      // change to take advantage of this earlier attachment point.
      const recorder = new SessionRecorder(sessionId, connectionId, userId);
      const sizeTracker = new SizeInstructionTracker();
      activeRecorders.set(sessionId, recorder);
      activeSizeTrackers.set(sessionId, sizeTracker);
      clientConnection.guacdClient.on('data', (data: Buffer) => {
        const text = data.toString();
        sizeTracker.feed(text);
        recorder.write(text);
      });

      await db.none(
        `INSERT INTO sessions (id, connection_id, owner_user_id, guacd_connection_id, rdp_drive_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, connectionId, userId, clientConnection.guacamoleConnectionId, rdpDriveId ?? null]
      );
      await db.none(
        `INSERT INTO session_participants (session_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [sessionId, userId]
      );

      // Ad-hoc connections (routes/tunnelToken.ts's issueAdhocConnectionToken)
      // have no saved connection row at all — connectionId is null for
      // them throughout, by design, so there's nothing here to look
      // force_record up from at all. Treated as never force-recorded
      // (the manual mid-session recording toggle below still works fine
      // regardless) rather than querying with a null id, which would
      // throw immediately — db.one() finds zero rows for `id = NULL`,
      // since SQL NULL never equals anything, including itself.
      const connection = connectionId ? await db.one(`SELECT force_record FROM connections WHERE id = $1`, [connectionId]) : null;
      // Real bug found live: recording started via the manual mid-session
      // toggle (the common path — force_record is opt-in per connection)
      // never contained a "size" instruction at all, since guacd only
      // sends one at connection open and on actual resize events, not on
      // every frame, and the recorder only starts writing from the
      // moment it's told to — with no way to retroactively capture what
      // was already sent before that. Playback then had nothing to size
      // the display from, so it stayed invisible (0×0) the entire time,
      // even while frames otherwise decoded and advanced correctly. This
      // tracker runs unconditionally on every session's stream — not
      // just while a recorder is active — so a "size" instruction sent
      // once, long before the user ever toggles recording on, is still
      // available whenever recording actually starts (see
      // SessionRecorder.start()'s own use of this).
      if (connection?.force_record) await recorder.start(sizeTracker.getLastSizeInstruction());

      // Stashed on the clientConnection itself so the 'close' handler (a
      // separate top-level event, not nested under 'open' the way 0.6.x
      // nested 'ready' under 'connection') can find the right
      // sessionId/recorder again.
      clientConnection.__ownedSessionId = sessionId;
    } catch (err) {
      logger.error({ err, connectionSettings: clientConnection?.connectionSettings }, 'Error handling guacd open event');
    }
  });

  guacServer.on('close', async (clientConnection: any) => {
    try {
      const { userId, joinSessionId } = clientConnection.connectionSettings ?? {};

      if (joinSessionId) {
        // A joiner disconnecting doesn't end the underlying session — only
        // their own participation in it. Marks the most recent still-open
        // ledger row for this user on this session as left.
        await db.none(
          `UPDATE session_participants SET left_at = now()
           WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [joinSessionId, userId]
        );
        activeJoinedConnections.get(joinSessionId)?.delete(userId);
        return;
      }

      const sessionId = clientConnection.__ownedSessionId;
      if (!sessionId) return; // connection closed before 'open' ever fully completed

      const recorder = activeRecorders.get(sessionId);
      await recorder?.stop();
      activeRecorders.delete(sessionId);
      activeSizeTrackers.delete(sessionId);

      const session = await db.oneOrNone(`SELECT rdp_drive_id FROM sessions WHERE id = $1`, [sessionId]);
      if (session?.rdp_drive_id) rdpDrive.cleanupDrive(session.rdp_drive_id);

      // The owner's own connection ending is what actually ends the shared
      // session for everyone. Previously this only reflected that
      // assumption in the database (marking every participant as left) on
      // the theory that guacd itself drops every joined client along with
      // the primary connection — reported live as not reliably true in
      // practice, with a joined participant's own session observed
      // remaining open after the owner stopped theirs. This now closes
      // every currently-joined participant's own connection directly and
      // explicitly from this side too, rather than depending on that
      // guacd-side behavior alone.
      disconnectAllJoined(sessionId);
      await db.none(
        `UPDATE session_participants SET left_at = now() WHERE session_id = $1 AND left_at IS NULL`,
        [sessionId]
      );
      await db.none(`UPDATE sessions SET ended_at = now() WHERE id = $1`, [sessionId]);
    } catch (err) {
      logger.error({ err, connectionSettings: clientConnection?.connectionSettings }, 'Error handling guacd close event');
    }
  });

  guacServer.on('error', (clientConnection: any, error: Error) => {
    logAudit({
      userId: clientConnection?.connectionSettings?.userId ?? null,
      action: 'guacd_connection_error',
      detail: { message: error?.message }
    }).catch(() => {});
  });

  return guacServer;
}

export async function toggleRecording(
  sessionId: string,
  userId: string,
  action: 'start' | 'stop',
  sourceIp?: string | null
) {
  const recorder = activeRecorders.get(sessionId);
  if (!recorder) throw new Error('session_not_found_or_not_owner');

  await logAudit({
    userId,
    action: action === 'start' ? 'record_start' : 'record_stop',
    detail: { sessionId },
    sourceIp
  });

  if (action === 'start' && !recorder.isRecording) {
    const sizeTracker = activeSizeTrackers.get(sessionId);
    await recorder.start(sizeTracker?.getLastSizeInstruction());
  }
  if (action === 'stop' && recorder.isRecording) await recorder.stop();

  return { recording: recorder.isRecording, recordingId: recorder.recordingId };
}
