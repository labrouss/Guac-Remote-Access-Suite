import { Worker } from 'bullmq';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import pgPromise from 'pg-promise';
import { logger } from './logger';

const execFileAsync = promisify(execFile);
const pgp = pgPromise({});
const db = pgp({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD
});

const connection = { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT ?? 6379) };

new Worker(
  'video-export',
  async (job) => {
    const { recordingId } = job.data;
    const rec = await db.oneOrNone(`SELECT * FROM session_recordings WHERE id = $1`, [recordingId]);
    if (!rec) throw new Error(`Recording ${recordingId} not found`);
    if (!fs.existsSync(rec.file_path)) throw new Error('Source .guac file missing');

    const outputPath = rec.file_path.replace(/\.guac$/, '.m4v');
    await db.none(`UPDATE session_recordings SET export_status = 'processing' WHERE id = $1`, [recordingId]);

    try {
      await execFileAsync('guacenc', ['-s', '1920x1080', '-r', '30', '-f', rec.file_path]);
      const stat = fs.statSync(outputPath);

      await db.none(
        `UPDATE session_recordings
         SET video_path = $1, video_encoded_at = now(), video_size_bytes = $2, export_status = 'completed'
         WHERE id = $3`,
        [outputPath, stat.size, recordingId]
      );
      await db.none(
        `INSERT INTO audit_log (user_id, connection_id, action, detail)
         VALUES ($1, $2, 'recording_exported', $3)`,
        [rec.user_id, rec.connection_id, JSON.stringify({ recordingId, outputPath })]
      );
    } catch (err) {
      logger.error({ err, recordingId }, 'Video export failed');
      await db.none(`UPDATE session_recordings SET export_status = 'failed' WHERE id = $1`, [recordingId]);
      throw err;
    }
  },
  { connection, concurrency: 2 }
);

// Retention cleanup: purge recordings past their retention window, once a day.
// RECORDING_RETENTION_DAYS defaults conservatively; override per-deployment via .env.
const RETENTION_DAYS = Number(process.env.RECORDING_RETENTION_DAYS ?? 90);

// Arbitrary fixed key for pg_advisory_lock — only matters that it's unique
// within this database and consistent across every worker replica. Without
// this, running more than one guac-worker instance would have each replica
// independently query and delete the same expired rows/files, racing on the
// filesystem unlink and occasionally erroring on an already-deleted row.
const RETENTION_LOCK_KEY = 847_291;

async function cleanupOldRecordings() {
  // pg_try_advisory_xact_lock (not the plain session-scoped variant) since
  // pg-promise pools connections — a session-scoped lock's unlock could land
  // on a different pooled connection than the one that acquired it. The
  // xact-scoped lock releases automatically when this transaction ends, no
  // matter which connection ends up running it.
  await db.tx(async (t) => {
    const { locked } = await t.one(`SELECT pg_try_advisory_xact_lock($1) AS locked`, [RETENTION_LOCK_KEY]);
    if (!locked) {
      logger.info('Retention cleanup already running on another worker — skipping this pass');
      return;
    }

    const old = await t.any(
      `SELECT id, file_path, video_path FROM session_recordings
       WHERE started_at < now() - ($1 || ' days')::interval`,
      [RETENTION_DAYS]
    );
    for (const rec of old) {
      for (const p of [rec.file_path, rec.video_path]) {
        if (p && fs.existsSync(p)) fs.unlinkSync(p);
      }
      await t.none(`DELETE FROM session_recordings WHERE id = $1`, [rec.id]);
    }
    if (old.length) logger.info({ count: old.length, retentionDays: RETENTION_DAYS }, 'Purged expired recordings');
  });
}

setInterval(cleanupOldRecordings, 24 * 60 * 60 * 1000);
cleanupOldRecordings().catch((err) => logger.error({ err }, 'Initial cleanup pass failed'));

// Storage-quota alerting: no automatic action (deleting someone's recordings
// early because a quota tripped would be worse than the disk-space problem
// itself), just a loud, repeated log line once cumulative recording storage
// crosses a configurable threshold — something a log-based alert rule can
// page on. Defaults to no limit (0 = disabled) since not every deployment
// wants this.
const MAX_RECORDINGS_BYTES = Number(process.env.MAX_RECORDINGS_BYTES ?? 0);

async function checkStorageQuota() {
  if (!MAX_RECORDINGS_BYTES) return;

  const { total } = await db.one(
    `SELECT COALESCE(SUM(file_size_bytes), 0) + COALESCE(SUM(video_size_bytes), 0) AS total
     FROM session_recordings`
  );
  const totalBytes = Number(total);

  if (totalBytes >= MAX_RECORDINGS_BYTES) {
    logger.warn(
      { totalBytes, limitBytes: MAX_RECORDINGS_BYTES },
      'Recording storage has exceeded the configured quota — consider lowering RECORDING_RETENTION_DAYS or expanding storage'
    );
  } else if (totalBytes >= MAX_RECORDINGS_BYTES * 0.9) {
    logger.warn({ totalBytes, limitBytes: MAX_RECORDINGS_BYTES }, 'Recording storage is above 90% of the configured quota');
  }
}

setInterval(checkStorageQuota, 60 * 60 * 1000); // hourly is frequent enough for a slow-moving metric like this
checkStorageQuota().catch((err) => logger.error({ err }, 'Initial storage quota check failed'));

logger.info('guac-worker: video export worker started');
