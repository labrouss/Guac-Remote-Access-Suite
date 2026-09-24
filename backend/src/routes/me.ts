import { Router } from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { db } from '../db';
import { logAuditFromRequest } from '../services/auditLog';
import { generateTotpEnrollment, verifyTotpCode } from '../services/totp';
import {
  generatePasskeyRegistrationOptions,
  verifyAndStorePasskeyRegistration,
  listPasskeysForUser,
  deletePasskey
} from '../services/webauthn';

const JWT_SECRET = process.env.JWT_SECRET!;

export const meRouter = Router();

meRouter.get('/', async (req, res) => {
  // Includes `id` — previously omitted, which several drafted integration/
  // e2e tests (tests-integration/demoAccess.integration.test.ts) had
  // already worked around by fetching it from the admin user-creation
  // response instead. Adding it here is the more correct fix: a user's
  // own "who am I" endpoint should return their own id.
  const user = await db.one(
    `SELECT id, username, totp_enabled, must_change_password FROM users WHERE id = $1`,
    [req.userId]
  );
  res.json(user);
});

meRouter.post('/change-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 12) {
    return res.status(400).json({ error: 'invalid_input', message: 'New password must be at least 12 characters.' });
  }

  const user = await db.one(`SELECT password_hash FROM users WHERE id = $1`, [req.userId]);
  const currentOk = await argon2.verify(user.password_hash, currentPassword);
  if (!currentOk) return res.status(401).json({ error: 'current_password_incorrect' });

  const newHash = await argon2.hash(newPassword);
  await db.none(
    `UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2`,
    [newHash, req.userId]
  );
  await logAuditFromRequest(req, 'password_changed_by_user');
  res.json({ status: 'changed' });
});

// Self-service 2FA enrollment — no way for any user (beyond the very
// first admin account, enrolled inline during the setup wizard) to
// enable 2FA existed at all before this. Genuinely couldn't be an
// admin-driven action instead: enrollment needs the user's own
// authenticator app to scan a QR code, so only the user themselves can
// ever complete it — an admin can only clear an existing enrollment
// (see POST /api/admin/users/:id/reset-totp), never create one on
// someone else's behalf.
//
// Deliberately stateless rather than stashing the pending secret in
// req.session, unlike setup.ts's identical-looking enroll/verify pair:
// setup.ts explicitly relies on a cookie-based session because that
// flow predates any Bearer token existing at all, but every other
// authenticated request in this app (including these) only ever sends
// the Bearer header, not credentials: 'include' — a session cookie
// would not reliably round-trip here. The encrypted secret is instead
// handed back to the client after enroll and sent back again with the
// verification code; safe to do since it's already Vault-encrypted, not
// the raw secret, when it leaves the server.
meRouter.post('/totp/enroll', async (req, res) => {
  const user = await db.one(`SELECT username FROM users WHERE id = $1`, [req.userId]);
  const config = await db.oneOrNone(`SELECT instance_name FROM system_config WHERE id = true`);
  const { otpauthUrl, secretEncrypted } = await generateTotpEnrollment(user.username, config?.instance_name);
  res.json({ otpauthUrl, secretEncrypted });
});

meRouter.post('/totp/verify', async (req, res) => {
  const { code, secretEncrypted } = req.body;
  if (!secretEncrypted) return res.status(400).json({ error: 'invalid_input', message: 'secretEncrypted is required.' });

  const valid = await verifyTotpCode(secretEncrypted, code);
  if (!valid) return res.status(400).json({ error: 'invalid_code' });

  await db.none(
    `UPDATE users SET totp_secret_encrypted = $1, totp_enabled = true WHERE id = $2`,
    [secretEncrypted, req.userId]
  );
  await logAuditFromRequest(req, 'totp_enabled_by_user');
  res.json({ status: 'verified' });
});

// Passkeys — requested directly ("like Google and some sites do").
// Same stateless-round-trip shape as the TOTP pair above and for the
// identical reason (no session cookie reliably round-trips on this
// Bearer-only API): the challenge generated below is wrapped in a
// short-lived JWT and handed back to the client, which sends it back
// again alongside the actual WebAuthn response. That JWT is what
// carries the challenge across the two requests, not what secures the
// ceremony itself — the real cryptographic guarantee is the
// authenticator's own signature over the challenge, which
// verifyAndStorePasskeyRegistration re-derives and checks independently
// regardless of what this token claims. Its only two jobs are giving
// the challenge a short server-side TTL (60s, tighter than the
// registration UI's own timeout — a browser dialog left open past that
// point should fail cleanly rather than let a stale challenge linger
// indefinitely) and confirming the response used to complete
// registration is being submitted by the same authenticated user who
// started it, via requireAuth's own userId, not anything the client
// could substitute.
meRouter.post('/passkeys/register-options', async (req, res) => {
  const user = await db.one(`SELECT username FROM users WHERE id = $1`, [req.userId]);
  const options = await generatePasskeyRegistrationOptions(req.userId!, user.username);
  const registrationToken = jwt.sign(
    { sub: req.userId, challenge: options.challenge, stage: 'webauthn_registration_pending' },
    JWT_SECRET,
    { expiresIn: '60s' }
  );
  res.json({ options, registrationToken });
});

meRouter.post('/passkeys/register-verify', async (req, res) => {
  const { registrationToken, response, name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'invalid_input', message: 'A name for this passkey is required.' });

  let payload: { sub: string; challenge: string; stage: string };
  try {
    payload = jwt.verify(registrationToken, JWT_SECRET) as typeof payload;
  } catch {
    return res.status(400).json({ error: 'invalid_or_expired_registration_token' });
  }
  // Belt-and-suspenders alongside requireAuth: this token could in
  // principle be replayed by the same user against a *different*
  // now-current request, so it's still checked against req.userId
  // rather than trusted as the sole source of whose registration this is.
  if (payload.stage !== 'webauthn_registration_pending' || payload.sub !== req.userId) {
    return res.status(400).json({ error: 'invalid_registration_token' });
  }

  const result = await verifyAndStorePasskeyRegistration(req.userId!, payload.challenge, response, name.trim());
  if (!result.ok) return res.status(400).json({ error: 'verification_failed', message: result.message });

  await logAuditFromRequest(req, 'passkey_registered', { name: name.trim() });
  res.json({ status: 'registered' });
});

meRouter.get('/passkeys', async (req, res) => {
  const passkeys = await listPasskeysForUser(req.userId!);
  res.json(passkeys);
});

meRouter.delete('/passkeys/:id', async (req, res) => {
  const deleted = await deletePasskey(req.userId!, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'not_found' });
  // The removed passkey's own id goes in `detail`, not the 4th
  // (connectionId) parameter — that column is a real foreign key to
  // connections(id) specifically (migration 016), and a passkey's row
  // id would fail that constraint outright, the same class of bug this
  // project already hit once before for connection deletion itself.
  await logAuditFromRequest(req, 'passkey_removed', { passkeyId: req.params.id });
  res.json({ status: 'removed' });
});
