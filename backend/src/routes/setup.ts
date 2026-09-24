import { Router } from 'express';
import argon2 from 'argon2';
import { db } from '../db';
import { checkVaultHealth } from '../services/vaultClient';
import { generateTotpEnrollment, verifyTotpCode } from '../services/totp';
import { provisionPersonalList } from '../services/userProvisioning';
import { logAudit } from '../services/auditLog';
import { issueCsrfToken, requireCsrfToken } from '../services/csrf';

export const setupRouter = Router();

export type SetupAdminResult =
  | { status: 'already_completed' }
  | { status: 'invalid_input'; message: string }
  | { status: 'ok'; userId: string };

/**
 * The full logic for creating (or resuming) the first admin account,
 * extracted out of the route handler for direct unit testing — same
 * pattern as issueNewConnectionToken/issueJoinToken elsewhere in this
 * codebase. Resuming an interrupted setup (a crash, a browser refresh, a
 * dropped connection — anything that got the admin account created but
 * never reached /complete) is treated as picking up where setup left off,
 * not a conflict — found via a live deployment: a backend crash between
 * this step and TOTP enrollment left the wizard permanently stuck, since
 * every retry of this step hit a duplicate-username 409 with no way to
 * proceed. Since setup_completed is still false at this point, nothing
 * else could have meaningfully used this account yet. Group membership
 * and the personal list are each checked/created independently rather
 * than assumed to already exist, since the earlier attempt could have
 * been interrupted at any point within this same sequence, not only after
 * all of it completed.
 */
export async function setupAdmin(username: string, password: string, instanceName: string): Promise<SetupAdminResult> {
  const config = await db.one(`SELECT setup_completed FROM system_config WHERE id = true`);
  if (config.setup_completed) return { status: 'already_completed' };

  if (!username || !password || password.length < 12) {
    return { status: 'invalid_input', message: 'Password must be at least 12 characters.' };
  }

  const passwordHash = await argon2.hash(password);

  const existingUser = await db.oneOrNone(`SELECT id FROM users WHERE username = $1`, [username]);
  let userId: string;

  if (existingUser) {
    await db.none(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, existingUser.id]);
    userId = existingUser.id;
  } else {
    const user = await db.one(`INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id`, [
      username,
      passwordHash
    ]);
    userId = user.id;
  }

  // Idempotent regardless of which branch above ran — user_groups has a
  // composite primary key on (user_id, group_id), so a bare ON CONFLICT
  // DO NOTHING correctly no-ops if this admin was already added.
  await db.none(
    `INSERT INTO user_groups (user_id, group_id) SELECT $1, id FROM groups WHERE name = 'Administrators'
     ON CONFLICT DO NOTHING`,
    [userId]
  );

  // provisionPersonalList is NOT itself safe to call twice for the same
  // user (connection_lists has a unique partial index allowing at most
  // one is_personal list per owner — a second call would throw) — checked
  // explicitly rather than assumed.
  const hasPersonalList = await db.oneOrNone(
    `SELECT id FROM connection_lists WHERE owner_id = $1 AND is_personal = true`,
    [userId]
  );
  if (!hasPersonalList) await provisionPersonalList(userId);

  await db.none(`UPDATE system_config SET instance_name = $1 WHERE id = true`, [instanceName]);

  return { status: 'ok', userId };
}

// Public status check — no auth required, this is what the frontend polls
// on every app load. Also issues (or returns the existing) CSRF token for
// this session, so the frontend has it before making any mutating call —
// see services/csrf.ts.
setupRouter.get('/status', async (req, res) => {
  const config = await db.one(`SELECT setup_completed FROM system_config WHERE id = true`);
  const csrfToken = issueCsrfToken(req);
  res.json({ setup_completed: config.setup_completed, csrfToken });
});

// Step 1: instance name + first admin account
setupRouter.post('/admin', requireCsrfToken, async (req, res) => {
  const { username, password, instanceName } = req.body;
  const result = await setupAdmin(username, password, instanceName);

  if (result.status === 'already_completed') return res.status(410).json({ error: result.status });
  if (result.status === 'invalid_input') {
    return res.status(400).json({ error: result.status, message: result.message });
  }

  req.session.setupUserId = result.userId;
  res.json({ userId: result.userId });
});

// Step 2a: generate a TOTP secret + QR payload for the first admin
setupRouter.post('/totp/enroll', requireCsrfToken, async (req, res) => {
  const user = await db.one(`SELECT username FROM users WHERE id = $1`, [req.session.setupUserId]);
  const config = await db.one(`SELECT instance_name FROM system_config WHERE id = true`);
  const { otpauthUrl, secretEncrypted } = await generateTotpEnrollment(user.username, config.instance_name);

  // Stash the encrypted secret in the setup session only until it's verified below —
  // it isn't written to users.totp_secret_encrypted until a correct code proves the
  // user actually scanned it into their authenticator app.
  req.session.pendingTotpSecret = secretEncrypted;
  res.json({ otpauthUrl });
});

// Step 2b: verify one code before committing the secret, so the first account
// is never left half-enrolled
setupRouter.post('/totp/verify', requireCsrfToken, async (req, res) => {
  const { code } = req.body;
  const secretEncrypted = req.session.pendingTotpSecret;
  if (!secretEncrypted) return res.status(400).json({ error: 'no_pending_enrollment' });

  const valid = await verifyTotpCode(secretEncrypted, code);
  if (!valid) return res.status(400).json({ error: 'invalid_code' });

  await db.none(
    `UPDATE users SET totp_secret_encrypted = $1, totp_enabled = true WHERE id = $2`,
    [secretEncrypted, req.session.setupUserId]
  );
  delete req.session.pendingTotpSecret;
  res.json({ status: 'verified' });
});

// Step 3: Vault connectivity check — fail clearly rather than let setup "succeed" with a broken link
setupRouter.post('/vault', requireCsrfToken, async (req, res) => {
  const { vaultAddr } = req.body;
  const healthy = await checkVaultHealth(vaultAddr);
  if (!healthy) {
    return res.status(502).json({ error: 'vault_unreachable', message: 'Could not reach Vault at the given address.' });
  }
  await db.none(`UPDATE system_config SET vault_addr = $1 WHERE id = true`, [vaultAddr]);
  res.json({ status: 'connected' });
});

// Step 4: default theme selection
setupRouter.post('/theme', requireCsrfToken, async (req, res) => {
  const { themeId } = req.body;
  await db.none(`UPDATE system_config SET default_theme_id = $1 WHERE id = true`, [themeId]);
  res.json({ status: 'set' });
});

// Final step: locks setup permanently
setupRouter.post('/complete', requireCsrfToken, async (req, res) => {
  await db.none(
    `UPDATE system_config SET setup_completed = true, setup_completed_at = now() WHERE id = true`
  );
  await logAudit({ userId: req.session.setupUserId ?? null, action: 'setup_completed', sourceIp: req.ip });
  res.json({ status: 'complete' });
});
