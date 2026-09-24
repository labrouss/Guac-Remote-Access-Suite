import dgram from 'dgram';
import net from 'net';
import tls from 'tls';

/**
 * Deliberately dependency-free: RFC 5424 formatting is simple enough string
 * construction that pulling in a third-party syslog package (several of
 * which are unmaintained) isn't worth the added supply-chain surface for
 * what this needs. Supports the three transports a real syslog server
 * (rsyslog, syslog-ng, a SIEM's ingest endpoint) commonly expects: UDP
 * (fire-and-forget, most common), TCP (reliable delivery), and TLS-wrapped
 * TCP (encrypted delivery — the only one of the three appropriate for
 * sending audit data over an untrusted network).
 */

export type SyslogProtocol = 'udp' | 'tcp' | 'tls';

export interface SyslogConfig {
  enabled: boolean;
  host: string;
  port: number;
  protocol: SyslogProtocol;
  facility: number; // RFC 5424 facility code, e.g. 4 = auth, 16-23 = local0-7
  appName: string;
}

const FACILITY_LOCAL0 = 16;

export function loadSyslogConfigFromEnv(): SyslogConfig {
  return {
    enabled: process.env.SYSLOG_ENABLED === 'true',
    host: process.env.SYSLOG_HOST ?? 'localhost',
    port: Number(process.env.SYSLOG_PORT ?? 514),
    protocol: (process.env.SYSLOG_PROTOCOL as SyslogProtocol) ?? 'udp',
    facility: process.env.SYSLOG_FACILITY ? Number(process.env.SYSLOG_FACILITY) : FACILITY_LOCAL0,
    appName: process.env.SYSLOG_APP_NAME ?? 'guac-access-suite'
  };
}

/** RFC 5424 severity levels — audit events default to 'informational' (6). */
export enum SyslogSeverity {
  Emergency = 0,
  Alert = 1,
  Critical = 2,
  Error = 3,
  Warning = 4,
  Notice = 5,
  Informational = 6,
  Debug = 7
}

/**
 * Builds a single RFC 5424 syslog message. Exported (not just used
 * internally) so it's directly unit-testable without a real socket — see
 * syslogForwarder.test.ts.
 *
 * Format: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID
 * STRUCTURED-DATA MSG
 */
export function formatRfc5424Message(
  config: SyslogConfig,
  severity: SyslogSeverity,
  msgId: string,
  message: string
): string {
  const priority = config.facility * 8 + severity;
  const timestamp = new Date().toISOString();
  const hostname = process.env.HOSTNAME ?? 'guac-access-suite';
  const procId = process.pid;
  // No structured data (RFC 5424's [SD-ID ...] blocks) — the JSON detail
  // blob already carries structure, and NILVALUE ('-') is valid and simpler
  // than mapping arbitrary audit detail fields onto SD-PARAMs.
  return `<${priority}>1 ${timestamp} ${hostname} ${config.appName} ${procId} ${msgId} - ${message}`;
}

let tcpSocket: net.Socket | tls.TLSSocket | null = null;

/**
 * Sends one formatted message. UDP is fire-and-forget (a dropped audit
 * event on an unreachable syslog server should never block or crash the
 * app — audit logging to Postgres is the durable record; syslog is a
 * secondary forward). TCP/TLS reuse one persistent connection rather than
 * opening a new socket per message, reconnecting lazily if the connection
 * has dropped.
 */
export function sendSyslogMessage(config: SyslogConfig, formattedMessage: string): void {
  if (!config.enabled) return;

  const buffer = Buffer.from(formattedMessage, 'utf8');

  if (config.protocol === 'udp') {
    const socket = dgram.createSocket('udp4');
    socket.send(buffer, config.port, config.host, (err) => {
      socket.close();
      if (err) logSyslogFailure(err);
    });
    return;
  }

  // TCP/TLS: syslog-over-TCP (RFC 6587) framing — each message prefixed
  // with its own byte length, so the receiving end can split messages on a
  // stream without relying on newline-delimiting (which would break if a
  // message body ever contained a literal newline).
  const framed = `${buffer.length} ${formattedMessage}`;

  try {
    if (!tcpSocket || tcpSocket.destroyed) {
      tcpSocket =
        config.protocol === 'tls'
          ? tls.connect({ host: config.host, port: config.port })
          : net.connect({ host: config.host, port: config.port });
      tcpSocket.on('error', logSyslogFailure);
    }
    tcpSocket.write(framed);
  } catch (err) {
    logSyslogFailure(err as Error);
  }
}

function logSyslogFailure(err: Error) {
  // Deliberately NOT using the app's own pino logger here to avoid a
  // feedback loop if pino itself is ever configured to also forward to
  // syslog — a plain stderr write is the safest fallback for "the thing
  // that reports failures" itself failing.
  process.stderr.write(`[syslogForwarder] failed to send: ${err.message}\n`);
}
