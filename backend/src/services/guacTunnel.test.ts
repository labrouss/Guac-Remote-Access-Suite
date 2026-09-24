import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ none: vi.fn(), oneOrNone: vi.fn(), one: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const rdpDriveMocks = vi.hoisted(() => ({ cleanupDrive: vi.fn(), createDrive: vi.fn() }));
vi.mock('./rdpDriveManager', () => rdpDriveMocks);

const logAuditMock = vi.hoisted(() => vi.fn());
vi.mock('./auditLog', () => ({ logAudit: logAuditMock }));

/**
 * NOTE ON WHAT MOVED: this file previously tested `resolveConnectionSettings`
 * — the authorization + credential-decryption + RDP-drive-setup logic that
 * used to live in guacamole-lite's processConnectionSettings callback.
 * That logic has since moved to routes/tunnelToken.ts (issueNewConnectionToken)
 * and routes/sessions.ts (issueJoinToken) — see the extensive comment in
 * guacTunnel.ts on exactly why: an empirically-verified race in
 * guacamole-lite 1.2.0 where guacd's client is constructed from a
 * synchronous snapshot of connection settings taken *before* any genuinely
 * async work in that callback can resolve, meaning real authorization
 * logic placed there would silently never take effect. Their own test
 * files (tunnelToken.test.ts, sessions.test.ts) now cover that logic
 * directly; this file covers what's actually left in guacTunnel.ts itself —
 * the token-freshness check, which is the one thing safe to keep in that
 * callback precisely because it requires no async I/O.
 */
import { attachGuacTunnel, activeJoinedConnections, disconnectJoinedUser, disconnectAllJoined } from './guacTunnel';

// passThroughConnectionSettings itself isn't exported (it's an internal
// implementation detail of attachGuacTunnel's callbacks object) — rather
// than export it purely for testability and add one more public surface to
// this module, these tests exercise it through a minimal fake
// GuacamoleLite constructor capture, consistent with treating
// attachGuacTunnel's wiring as the thing under test.
const capturedCallbacks: any[] = [];
vi.mock('guacamole-lite', () => ({
  default: class FakeGuacamoleLite {
    constructor(_server: any, _guacd: any, _client: any, callbacks: any) {
      capturedCallbacks.push(callbacks);
    }
    on() {}
  }
}));

let originalKey: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  capturedCallbacks.length = 0;
  // attachGuacTunnel now calls deriveGuacTokenKey() eagerly (a real,
  // deliberate change — see guacTokenKey.ts's own comment) rather than
  // just referencing the raw env var lazily, so it needs this set before
  // every call now, not just wherever it happens to already be set from
  // some other test's own setup.
  originalKey = process.env.GUAC_TOKEN_ENCRYPTION_KEY;
  process.env.GUAC_TOKEN_ENCRYPTION_KEY = 'test-key-for-guac-tunnel-tests';
});

afterEach(() => {
  if (originalKey !== undefined) process.env.GUAC_TOKEN_ENCRYPTION_KEY = originalKey;
  else delete process.env.GUAC_TOKEN_ENCRYPTION_KEY;
});

describe('attachGuacTunnel — processConnectionSettings pass-through', () => {
  it('passes through a fresh token unmodified', () => {
    attachGuacTunnel({} as any);
    const { processConnectionSettings } = capturedCallbacks[0];

    const settings = { userId: 'user-1', connectionId: 'conn-1', issuedAt: Date.now() };
    const callback = vi.fn();
    processConnectionSettings(settings, callback);

    expect(callback).toHaveBeenCalledWith(null, settings);
  });

  it('rejects a token older than the max age, without needing any async I/O to decide', () => {
    attachGuacTunnel({} as any);
    const { processConnectionSettings } = capturedCallbacks[0];

    const settings = { userId: 'user-1', connectionId: 'conn-1', issuedAt: Date.now() - 60_000 };
    const callback = vi.fn();
    processConnectionSettings(settings, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const [err, result] = callback.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('token_expired');
    expect(result).toBeNull();
  });

  it('does not reject a token with no issuedAt field at all (defensive default, not a hard requirement)', () => {
    attachGuacTunnel({} as any);
    const { processConnectionSettings } = capturedCallbacks[0];

    const settings = { userId: 'user-1', connectionId: 'conn-1' };
    const callback = vi.fn();
    processConnectionSettings(settings, callback);

    expect(callback).toHaveBeenCalledWith(null, settings);
  });
});

// Requested directly ("when I remove a user from sharing and/or stopping
// a session I would like the sharing on the user to also stop"): a share
// revocation, or the session owner's own connection ending, previously
// only ever updated the database — a joined participant's own already-
// open connection kept running regardless, with nothing telling it
// anything had changed. These two functions are what routes/sessions.ts's
// revoke route and this same file's own owner 'close' handler now call
// to actually close that connection directly, rather than only updating
// records about it.
describe('disconnectJoinedUser / disconnectAllJoined', () => {
  beforeEach(() => {
    activeJoinedConnections.clear();
  });

  function fakeClientConnection() {
    return { close: vi.fn() };
  }

  it('closes the specific joined user\'s connection when one is currently open', () => {
    const conn = fakeClientConnection();
    activeJoinedConnections.set('session-1', new Map([['user-a', conn]]));

    disconnectJoinedUser('session-1', 'user-a');

    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  it('disconnectJoinedUser is a safe no-op when the session has no joined connections tracked at all', () => {
    expect(() => disconnectJoinedUser('session-nonexistent', 'user-a')).not.toThrow();
  });

  it('is a safe no-op when the session exists but that specific user is not currently joined', () => {
    const conn = fakeClientConnection();
    activeJoinedConnections.set('session-1', new Map([['user-a', conn]]));

    expect(() => disconnectJoinedUser('session-1', 'user-b')).not.toThrow();
    expect(conn.close).not.toHaveBeenCalled();
  });

  it('does not close a connection for a different, unrelated session', () => {
    const connA = fakeClientConnection();
    const connB = fakeClientConnection();
    activeJoinedConnections.set('session-1', new Map([['user-a', connA]]));
    activeJoinedConnections.set('session-2', new Map([['user-a', connB]]));

    disconnectJoinedUser('session-1', 'user-a');

    expect(connA.close).toHaveBeenCalledTimes(1);
    expect(connB.close).not.toHaveBeenCalled();
  });

  it('closes every currently-joined participant\'s connection for a session, not just one', () => {
    const connA = fakeClientConnection();
    const connB = fakeClientConnection();
    const connC = fakeClientConnection();
    activeJoinedConnections.set('session-1', new Map([
      ['user-a', connA],
      ['user-b', connB],
      ['user-c', connC]
    ]));

    disconnectAllJoined('session-1');

    expect(connA.close).toHaveBeenCalledTimes(1);
    expect(connB.close).toHaveBeenCalledTimes(1);
    expect(connC.close).toHaveBeenCalledTimes(1);
  });

  it('does not touch a different, unrelated session\'s own joined connections', () => {
    const connSession1 = fakeClientConnection();
    const connSession2 = fakeClientConnection();
    activeJoinedConnections.set('session-1', new Map([['user-a', connSession1]]));
    activeJoinedConnections.set('session-2', new Map([['user-a', connSession2]]));

    disconnectAllJoined('session-1');

    expect(connSession1.close).toHaveBeenCalledTimes(1);
    expect(connSession2.close).not.toHaveBeenCalled();
  });

  it('disconnectAllJoined is a safe no-op when the session has no joined connections tracked at all', () => {
    expect(() => disconnectAllJoined('session-nonexistent')).not.toThrow();
  });

  it('clears the session\'s own map entry afterward, rather than leaving stale closed entries behind', () => {
    const conn = fakeClientConnection();
    activeJoinedConnections.set('session-1', new Map([['user-a', conn]]));

    disconnectAllJoined('session-1');

    expect(activeJoinedConnections.has('session-1')).toBe(false);
  });
});
