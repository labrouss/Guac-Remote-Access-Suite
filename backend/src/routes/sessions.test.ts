import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ oneOrNone: vi.fn(), any: vi.fn(), none: vi.fn(), one: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

vi.mock('../services/guacTunnel', () => ({ toggleRecording: vi.fn(), activeRecorders: new Map() }));
vi.mock('../services/videoExportQueue', () => ({ queueVideoExport: vi.fn() }));
vi.mock('../services/sshFileTransfer', () => ({ pushFileViaSftp: vi.fn() }));
vi.mock('../services/rdpDriveManager', () => ({
  createDrive: vi.fn(),
  getDrivePath: vi.fn(),
  markKnown: vi.fn(),
  takePendingDownloads: vi.fn()
}));
vi.mock('../services/permissions', () => ({ hasConnectionAccess: vi.fn() }));

const logAuditMock = vi.hoisted(() => vi.fn());
vi.mock('../services/auditLog', () => ({ logAuditFromRequest: vi.fn(), logAudit: logAuditMock }));

const encryptGuacTokenMock = vi.hoisted(() => vi.fn((_payload: any) => 'encrypted-join-token'));
vi.mock('../services/guacToken', () => ({ encryptGuacToken: encryptGuacTokenMock }));

import { issueJoinToken } from './sessions';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('issueJoinToken', () => {
  it('returns session_not_found_or_ended for a nonexistent session', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce(null);
    const result = await issueJoinToken('user-1', 'missing-session', false);
    expect(result).toEqual({ status: 'session_not_found_or_ended' });
  });

  it('the owner is always authorized, with no session_shares lookup performed at all', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ owner_user_id: 'user-1', guacd_connection_id: '$abc-123' });

    const result = await issueJoinToken('user-1', 'session-1', false);

    expect(result.status).toBe('ok');
    // Ownership alone should short-circuit the share check — the session
    // lookup was the only oneOrNone call made.
    expect(dbMock.oneOrNone).toHaveBeenCalledTimes(1);
  });

  it('a non-owner with a valid share grant is authorized', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ owner_user_id: 'owner-user', guacd_connection_id: '$abc-123' })
      .mockResolvedValueOnce({ role: 'viewer' });

    const result = await issueJoinToken('viewer-user', 'session-1', true);

    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.joinRole).toBe('viewer');
  });

  it('a non-owner with no share grant at all is rejected', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ owner_user_id: 'owner-user', guacd_connection_id: '$abc-123' })
      .mockResolvedValueOnce(null);

    const result = await issueJoinToken('stranger', 'session-1', false);
    expect(result).toEqual({ status: 'not_authorized' });
  });

  it('rejects joining when the session has no guacd_connection_id yet (narrow readiness race)', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ owner_user_id: 'user-1', guacd_connection_id: null });

    const result = await issueJoinToken('user-1', 'session-1', false);
    expect(result).toEqual({ status: 'session_not_ready_yet' });
  });

  it('embeds the real guacd_connection_id as the join target and the read-only flag exactly as given', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ owner_user_id: 'user-1', guacd_connection_id: '$the-real-guacd-id' });

    await issueJoinToken('user-1', 'session-1', true);

    const [tokenPayload] = encryptGuacTokenMock.mock.calls[0]!;
    expect(tokenPayload.connection.join).toBe('$the-real-guacd-id');
    expect(tokenPayload.connection.settings['read-only']).toBe(true);
    // No hostname/username/password for a join — it's joining an
    // already-authenticated session, not opening a new one.
    expect(tokenPayload.connection.settings.hostname).toBeUndefined();
  });

  it('resolves read-only to exactly false unless explicitly true (no truthy-string coercion surprises)', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ owner_user_id: 'user-1', guacd_connection_id: '$abc' });

    await issueJoinToken('user-1', 'session-1', 'yes' as any);

    const [tokenPayload] = encryptGuacTokenMock.mock.calls[0]!;
    expect(tokenPayload.connection.settings['read-only']).toBe(false);
  });

  it('includes an issuedAt timestamp for the synchronous freshness check in guacTunnel.ts', async () => {
    dbMock.oneOrNone.mockResolvedValueOnce({ owner_user_id: 'user-1', guacd_connection_id: '$abc' });

    await issueJoinToken('user-1', 'session-1', false);

    const [tokenPayload] = encryptGuacTokenMock.mock.calls[0]!;
    expect(typeof tokenPayload.issuedAt).toBe('number');
  });

  it('tags the token with joinSessionId and joinRole so guacTunnel.ts can record the join-event ledger', async () => {
    dbMock.oneOrNone
      .mockResolvedValueOnce({ owner_user_id: 'owner-user', guacd_connection_id: '$abc' })
      .mockResolvedValueOnce({ role: 'interactive' });

    await issueJoinToken('viewer-user', 'session-1', false);

    const [tokenPayload] = encryptGuacTokenMock.mock.calls[0]!;
    expect(tokenPayload.joinSessionId).toBe('session-1');
    expect(tokenPayload.joinRole).toBe('interactive');
  });
});
