import { Request } from 'express';
import { db } from '../db';
import {
  loadSyslogConfigFromEnv,
  formatRfc5424Message,
  sendSyslogMessage,
  SyslogSeverity,
  type SyslogConfig
} from './syslogForwarder';

/**
 * Single point every mutating route should go through, rather than the
 * hand-rolled `INSERT INTO audit_log` calls scattered across the codebase
 * before this — those had two real problems: `source_ip` was declared in
 * the schema but never once populated anywhere, and the vast majority of
 * mutating admin/demo/bookmark routes had no audit entry at all (an audit
 * before adding this found roughly 2 of 30). Centralizing here fixes both:
 * every call captures source_ip consistently, and it's a single place to
 * route to syslog without touching every call site again.
 */

const syslogConfig: SyslogConfig = loadSyslogConfigFromEnv();

export interface AuditLogEntry {
  userId: string | null;
  action: string;
  detail?: Record<string, unknown>;
  connectionId?: string | null;
  sourceIp?: string | null;
  severity?: SyslogSeverity;
}

export async function logAudit(entry: AuditLogEntry): Promise<void> {
  const detailJson = JSON.stringify(entry.detail ?? {});

  await db.none(
    `INSERT INTO audit_log (user_id, connection_id, action, detail, source_ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [entry.userId, entry.connectionId ?? null, entry.action, detailJson, entry.sourceIp ?? null]
  );

  if (syslogConfig.enabled) {
    const message = JSON.stringify({
      action: entry.action,
      userId: entry.userId,
      connectionId: entry.connectionId ?? null,
      sourceIp: entry.sourceIp ?? null,
      detail: entry.detail ?? {}
    });
    const formatted = formatRfc5424Message(
      syslogConfig,
      entry.severity ?? SyslogSeverity.Informational,
      'AUDIT',
      message
    );
    sendSyslogMessage(syslogConfig, formatted);
  }
}

/**
 * Convenience wrapper for the common case of logging from inside an Express
 * route handler — pulls userId and source IP off the request automatically.
 * `req.ip` reflects `X-Forwarded-For`/`X-Real-IP` correctly only if the app
 * has `trust proxy` enabled (see app.ts) — nginx.conf already sets
 * X-Real-IP, so this is the real client IP, not the reverse proxy's own.
 */
export async function logAuditFromRequest(
  req: Request,
  action: string,
  detail?: Record<string, unknown>,
  connectionId?: string | null
): Promise<void> {
  await logAudit({
    userId: (req as any).userId ?? null,
    action,
    detail,
    connectionId,
    sourceIp: req.ip ?? null
  });
}
