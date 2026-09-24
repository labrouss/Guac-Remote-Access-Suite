import { describe, it, expect, vi, beforeEach } from 'vitest';

const dgramSendMock = vi.hoisted(() => vi.fn((_buf, _port, _host, cb) => cb?.(null)));
const dgramCloseMock = vi.hoisted(() => vi.fn());
const createSocketMock = vi.hoisted(() =>
  vi.fn(() => ({ send: dgramSendMock, close: dgramCloseMock }))
);
vi.mock('dgram', () => ({ default: { createSocket: createSocketMock } }));

import { formatRfc5424Message, loadSyslogConfigFromEnv, sendSyslogMessage, SyslogSeverity, type SyslogConfig } from './syslogForwarder';

function testConfig(overrides: Partial<SyslogConfig> = {}): SyslogConfig {
  return {
    enabled: true,
    host: 'syslog.example.com',
    port: 514,
    protocol: 'udp',
    facility: 16, // local0
    appName: 'guac-access-suite',
    ...overrides
  };
}

describe('formatRfc5424Message', () => {
  it('computes PRI as facility*8 + severity', () => {
    const config = testConfig({ facility: 16 });
    const message = formatRfc5424Message(config, SyslogSeverity.Informational, 'AUDIT', 'test message');
    // facility 16 * 8 + severity 6 (Informational) = 134
    expect(message.startsWith('<134>1 ')).toBe(true);
  });

  it('uses a different PRI for a different severity, same facility', () => {
    const config = testConfig({ facility: 16 });
    const message = formatRfc5424Message(config, SyslogSeverity.Warning, 'AUDIT', 'test message');
    // 16*8 + 4 (Warning) = 132
    expect(message.startsWith('<132>1 ')).toBe(true);
  });

  it('uses a different PRI for a different facility, same severity', () => {
    const config = testConfig({ facility: 4 }); // auth facility
    const message = formatRfc5424Message(config, SyslogSeverity.Informational, 'AUDIT', 'test message');
    // 4*8 + 6 = 38
    expect(message.startsWith('<38>1 ')).toBe(true);
  });

  it('includes version "1" immediately after PRI, per RFC 5424', () => {
    const config = testConfig();
    const message = formatRfc5424Message(config, SyslogSeverity.Informational, 'AUDIT', 'x');
    expect(message).toMatch(/^<\d+>1 /);
  });

  it('includes an ISO 8601 timestamp', () => {
    const config = testConfig();
    const message = formatRfc5424Message(config, SyslogSeverity.Informational, 'AUDIT', 'x');
    const parts = message.split(' ');
    const timestamp = parts[1];
    expect(() => new Date(timestamp).toISOString()).not.toThrow();
    expect(new Date(timestamp).toString()).not.toBe('Invalid Date');
  });

  it('includes the configured app name', () => {
    const config = testConfig({ appName: 'my-custom-app' });
    const message = formatRfc5424Message(config, SyslogSeverity.Informational, 'AUDIT', 'x');
    expect(message).toContain('my-custom-app');
  });

  it('includes the given msgId', () => {
    const config = testConfig();
    const message = formatRfc5424Message(config, SyslogSeverity.Informational, 'CUSTOM_MSGID', 'x');
    expect(message).toContain(' CUSTOM_MSGID ');
  });

  it('ends with the message body, after a NILVALUE structured-data field', () => {
    const config = testConfig();
    const message = formatRfc5424Message(config, SyslogSeverity.Informational, 'AUDIT', 'the actual payload');
    expect(message).toMatch(/ - the actual payload$/);
  });

  it('preserves the message body exactly, including embedded JSON', () => {
    const config = testConfig();
    const payload = JSON.stringify({ action: 'login_success', userId: 'abc-123' });
    const message = formatRfc5424Message(config, SyslogSeverity.Informational, 'AUDIT', payload);
    expect(message.endsWith(payload)).toBe(true);
  });
});

describe('loadSyslogConfigFromEnv', () => {
  it('defaults to disabled when SYSLOG_ENABLED is unset', () => {
    delete process.env.SYSLOG_ENABLED;
    expect(loadSyslogConfigFromEnv().enabled).toBe(false);
  });

  it('is enabled only when SYSLOG_ENABLED is exactly "true"', () => {
    process.env.SYSLOG_ENABLED = 'yes';
    expect(loadSyslogConfigFromEnv().enabled).toBe(false);
    process.env.SYSLOG_ENABLED = 'true';
    expect(loadSyslogConfigFromEnv().enabled).toBe(true);
    delete process.env.SYSLOG_ENABLED;
  });

  it('defaults facility to 16 (local0) when SYSLOG_FACILITY is unset', () => {
    delete process.env.SYSLOG_FACILITY;
    expect(loadSyslogConfigFromEnv().facility).toBe(16);
  });

  it('respects an explicit SYSLOG_FACILITY override', () => {
    process.env.SYSLOG_FACILITY = '4';
    expect(loadSyslogConfigFromEnv().facility).toBe(4);
    delete process.env.SYSLOG_FACILITY;
  });

  it('defaults protocol to udp and port to 514', () => {
    delete process.env.SYSLOG_PROTOCOL;
    delete process.env.SYSLOG_PORT;
    const config = loadSyslogConfigFromEnv();
    expect(config.protocol).toBe('udp');
    expect(config.port).toBe(514);
  });
});

describe('sendSyslogMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing at all when the config is disabled — no socket created', () => {
    const config = testConfig({ enabled: false });
    sendSyslogMessage(config, 'some formatted message');
    expect(createSocketMock).not.toHaveBeenCalled();
  });

  it('sends via a UDP socket to the configured host/port when enabled', () => {
    const config = testConfig({ enabled: true, protocol: 'udp', host: 'syslog.example.com', port: 5514 });
    sendSyslogMessage(config, 'some formatted message');

    expect(createSocketMock).toHaveBeenCalledWith('udp4');
    expect(dgramSendMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      5514,
      'syslog.example.com',
      expect.any(Function)
    );
  });

  it('closes the UDP socket after sending, regardless of success', () => {
    const config = testConfig({ enabled: true, protocol: 'udp' });
    sendSyslogMessage(config, 'x');
    expect(dgramCloseMock).toHaveBeenCalled();
  });

  it('sends the exact message bytes given, unmodified', () => {
    const config = testConfig({ enabled: true, protocol: 'udp' });
    const message = '<134>1 2026-01-01T00:00:00.000Z host app 123 AUDIT - payload';
    sendSyslogMessage(config, message);

    const sentBuffer = dgramSendMock.mock.calls[0][0] as Buffer;
    expect(sentBuffer.toString('utf8')).toBe(message);
  });
});
