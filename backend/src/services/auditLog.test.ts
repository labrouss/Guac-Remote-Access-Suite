import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ none: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const sendSyslogMessageMock = vi.hoisted(() => vi.fn());
const formatRfc5424MessageMock = vi.hoisted(() => vi.fn(() => 'formatted-message'));
vi.mock('./syslogForwarder', async () => {
  const actual = await vi.importActual<typeof import('./syslogForwarder')>('./syslogForwarder');
  return {
    ...actual,
    sendSyslogMessage: sendSyslogMessageMock,
    formatRfc5424Message: formatRfc5424MessageMock
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SYSLOG_ENABLED;
});

describe('logAudit', () => {
  it('always writes to Postgres with all five columns, including source_ip', async () => {
    vi.resetModules();
    const { logAudit } = await import('./auditLog');
    await logAudit({ userId: 'user-1', action: 'login_success', detail: { foo: 'bar' }, sourceIp: '10.0.0.5' });

    expect(dbMock.none).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_log'),
      ['user-1', null, 'login_success', JSON.stringify({ foo: 'bar' }), '10.0.0.5']
    );
  });

  it('defaults detail to {} and connectionId/sourceIp to null when omitted', async () => {
    vi.resetModules();
    const { logAudit } = await import('./auditLog');
    await logAudit({ userId: 'user-1', action: 'setup_completed' });

    expect(dbMock.none).toHaveBeenCalledWith(
      expect.any(String),
      ['user-1', null, 'setup_completed', '{}', null]
    );
  });

  it('does NOT forward to syslog when SYSLOG_ENABLED is unset', async () => {
    delete process.env.SYSLOG_ENABLED;
    vi.resetModules();
    const { logAudit } = await import('./auditLog');
    await logAudit({ userId: 'user-1', action: 'login_success' });

    expect(sendSyslogMessageMock).not.toHaveBeenCalled();
  });

  it('forwards to syslog when SYSLOG_ENABLED=true, with the formatted message', async () => {
    process.env.SYSLOG_ENABLED = 'true';
    vi.resetModules();
    const { logAudit } = await import('./auditLog');
    await logAudit({ userId: 'user-1', action: 'login_success', detail: { x: 1 } });

    expect(sendSyslogMessageMock).toHaveBeenCalledWith(expect.anything(), 'formatted-message');
  });

  it('still writes to Postgres even when syslog forwarding is enabled', async () => {
    process.env.SYSLOG_ENABLED = 'true';
    vi.resetModules();
    const { logAudit } = await import('./auditLog');
    await logAudit({ userId: 'user-1', action: 'login_success' });

    expect(dbMock.none).toHaveBeenCalled();
  });
});

describe('logAuditFromRequest', () => {
  it('pulls userId from req.userId and sourceIp from req.ip automatically', async () => {
    vi.resetModules();
    const { logAuditFromRequest } = await import('./auditLog');
    const fakeReq = { userId: 'user-1', ip: '203.0.113.5' } as any;

    await logAuditFromRequest(fakeReq, 'connection_created', { name: 'test' }, 'conn-1');

    expect(dbMock.none).toHaveBeenCalledWith(
      expect.any(String),
      ['user-1', 'conn-1', 'connection_created', JSON.stringify({ name: 'test' }), '203.0.113.5']
    );
  });

  it('handles a request with no authenticated user (userId undefined) as null, not throwing', async () => {
    vi.resetModules();
    const { logAuditFromRequest } = await import('./auditLog');
    const fakeReq = { ip: '203.0.113.5' } as any;

    await expect(logAuditFromRequest(fakeReq, 'login_failed', { username: 'nobody' })).resolves.not.toThrow();
    expect(dbMock.none).toHaveBeenCalledWith(
      expect.any(String),
      [null, null, 'login_failed', JSON.stringify({ username: 'nobody' }), '203.0.113.5']
    );
  });
});
