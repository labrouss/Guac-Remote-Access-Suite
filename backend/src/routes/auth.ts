import { Router } from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { db } from '../db';
import { verifyTotpCode } from '../services/totp';
import { logAudit } from '../services/auditLog';
import { issueSessionToken } from '../services/sessionToken';
import { generatePasskeyAuthenticationOptions, verifyPasskeyAuthentication } from '../services/webauthn';
import { isAdEnabled, authenticateAgainstAd, findOrProvisionAdUser, storeAdPassthroughCredential, syncAdGroupMemberships } from '../services/activeDirectory';

export const authRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET!;

// Applied per-route rather than globally: 10 attempts per 15 minutes per IP
// on the password step, and separately on the TOTP step, since this is the
// one part of the app that's reachable by anyone with no auth at all yet —
// exactly where credential-stuffing and TOTP-brute-force attempts land.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts', message: 'Too many login attempts. Try again in a few minutes.' }
});

const totpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts', message: 'Too many verification attempts. Try again in a few minutes.' }
});

// Step 1: username + password. Returns a short-lived "pending" token, not a
// full session, if the account has TOTP enabled — full session is only issued
// after the second factor succeeds.
//
// Local and AD accounts share this one route and one rate limiter, rather
// than a separate /login-ad endpoint — the login form itself never needs
// to know or ask which kind of account a username belongs to.
//
// auth_source (migration 021), not password_hash being null, decides which
// path a given username takes: an existing row is authoritative about its
// own kind once one exists, local or AD, and is never silently
// reinterpreted as the other just because a matching username also exists
// in AD — a local "alice" created before AD was ever turned on, and a real
// AD "alice" logging in later, are kept as two separate identities, never
// merged. Only a username with no local row at all is eligible to become
// a new, JIT-provisioned AD account.
authRouter.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const user = await db.oneOrNone(
    `SELECT id, password_hash, auth_source, totp_enabled, disabled_at, must_change_password FROM users WHERE username = $1`,
    [username]
  );

  if (user && user.auth_source === 'local') {
    // Same generic error whether the user doesn't exist or the password is wrong —
    // don't leak which one it was.
    if (user.disabled_at) {
      await logAudit({ userId: null, action: 'login_failed', detail: { username }, sourceIp: req.ip });
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const passwordOk = await argon2.verify(user.password_hash, password);
    if (!passwordOk) {
      await logAudit({ userId: user.id, action: 'login_failed', detail: { username }, sourceIp: req.ip });
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    return completeLogin(req, res, user);
  }

  // AD path: either no local row exists at all yet (a possible first-ever
  // login for this username), or one already does with auth_source = 'ad'
  // (a repeat login for a previously-provisioned AD account) — either way,
  // this username is never a 'local' account, so it's AD's to try.
  if (isAdEnabled() && (!user || user.auth_source === 'ad')) {
    // An admin's own "disable" action (admin.ts's existing
    // DELETE-equivalent toggle) has to actually take effect for a
    // previously-provisioned AD account too — this app's own
    // disabled_at is a separate, local override on top of whatever AD
    // itself still says about the account, an emergency "revoke access
    // to this app specifically" lever independent of AD group
    // membership. A first-ever login has no row yet to check this
    // against at all, so this only applies once `user` already exists.
    if (user?.disabled_at) {
      await logAudit({ userId: user.id, action: 'login_failed', detail: { username }, sourceIp: req.ip });
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const adResult = await authenticateAgainstAd(username, password);
    if (!adResult.ok) {
      // A real gap found and fixed in response to someone unable to
      // diagnose their own failed AD login: adResult.reason was
      // computed (empty_password/user_not_found/ambiguous_user/
      // invalid_credentials/not_in_required_group/ldap_error) but never
      // actually recorded anywhere — the response to the browser stays
      // deliberately generic either way (never leak which specific case
      // it was to whoever's at the login form, same reasoning as the
      // existing local-password path), but an admin looking at the
      // audit log afterward genuinely needs to know which one it was,
      // and had no way to. Safe to record here specifically because the
      // audit log itself is admin-only (GET /api/admin/audit-log) — this
      // isn't exposed to the person who just failed to log in.
      await logAudit({ userId: user?.id ?? null, action: 'login_failed', detail: { username, reason: adResult.reason }, sourceIp: req.ip });
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const adUser = await findOrProvisionAdUser(adResult.resolvedUsername!);
    // Captured here, right after the real AD bind above succeeded — not
    // gated behind whether this app's own TOTP is also about to be
    // required below, since the password itself is already verified by
    // this point regardless of what happens next.
    await storeAdPassthroughCredential(adUser.id, adResult.resolvedUsername!, password);
    // Re-evaluated on every login, first-time or repeat alike — not just
    // once at JIT provisioning — see syncAdGroupMemberships's own
    // comment for why this is a genuine, ongoing sync rather than a
    // one-time grant, and what that means for an admin's own manual
    // group changes.
    await syncAdGroupMemberships(adUser.id, adResult.memberOf ?? []);

    return completeLogin(req, res, {
      id: adUser.id,
      totp_enabled: adUser.totpEnabled,
      must_change_password: adUser.mustChangePassword,
    }, { method: 'ad' });
  }

  await logAudit({ userId: null, action: 'login_failed', detail: { username }, sourceIp: req.ip });
  return res.status(401).json({ error: 'invalid_credentials' });
});

// Shared by both the local and AD paths above: same "issue a TOTP-pending
// token if this account has 2FA enabled, otherwise a real session"
// decision either way. Deliberately keyed off the account's own
// totp_enabled, not its auth_source — an AD account that's voluntarily
// turned on TOTP for itself (self-service, from the header's own user
// menu, same as any local account) is asked for it here exactly the same
// way; one that hasn't isn't, also exactly the same way. No separate
// "should AD accounts need 2FA" policy to configure: this is already
// per-account, self-service, and uniform across both kinds.
async function completeLogin(
  req: import('express').Request,
  res: import('express').Response,
  user: { id: string; totp_enabled: boolean; must_change_password: boolean },
  auditDetail: Record<string, unknown> = {},
) {
  if (user.totp_enabled) {
    const pendingToken = jwt.sign({ sub: user.id, stage: 'totp_pending' }, JWT_SECRET, { expiresIn: '5m' });
    return res.json({ requiresTotp: true, pendingToken });
  }

  const sessionToken = issueSessionToken(user.id);
  await logAudit({ userId: user.id, action: 'login_success', detail: auditDetail, sourceIp: req.ip });
  res.json({ requiresTotp: false, sessionToken, mustChangePassword: user.must_change_password });
}

// Step 2: TOTP code, exchanging the pending token for a real session
authRouter.post('/login/totp', totpLimiter, async (req, res) => {
  const { pendingToken, code } = req.body;

  let payload: { sub: string; stage: string };
  try {
    payload = jwt.verify(pendingToken, JWT_SECRET) as typeof payload;
  } catch {
    return res.status(401).json({ error: 'invalid_or_expired_pending_token' });
  }
  if (payload.stage !== 'totp_pending') return res.status(401).json({ error: 'invalid_pending_token' });

  const user = await db.one(`SELECT totp_secret_encrypted, must_change_password, auth_source FROM users WHERE id = $1`, [payload.sub]);
  const valid = await verifyTotpCode(user.totp_secret_encrypted, code);
  if (!valid) {
    await logAudit({ userId: payload.sub, action: 'totp_failed', detail: {}, sourceIp: req.ip });
    return res.status(401).json({ error: 'invalid_code' });
  }

  const sessionToken = issueSessionToken(payload.sub);
  // Same method tag completeLogin's own non-TOTP branch attaches — this is
  // the only login_success entry an AD account with TOTP enabled ever
  // gets (the earlier /login call only issued a pending token, logging
  // nothing yet), so the audit trail would otherwise lose which kind of
  // account this login actually was.
  await logAudit({ userId: payload.sub, action: 'login_success', detail: user.auth_source === 'ad' ? { method: 'ad' } : {}, sourceIp: req.ip });
  res.json({ sessionToken, mustChangePassword: user.must_change_password });
});

// Passkey login — requested directly ("like Google and some sites do"),
// deliberately usernameless: generatePasskeyAuthenticationOptions omits
// allowCredentials entirely, so the authenticator itself surfaces
// whichever passkeys it holds for this origin without anyone having
// typed a username first. Which real user that turns out to be is only
// known once the response comes back with a specific credential id in
// it (verifyPasskeyAuthentication looks it up from there), so there's
// no username to key a rate limiter or an audit log entry by until
// that point — loginLimiter is still applied per-IP here for the same
// credential-stuffing-adjacent reasons as the password step above, even
// though what's actually being brute-forced here would be a forged
// signature, not a guessed password.
authRouter.post('/passkey/options', loginLimiter, async (_req, res) => {
  const options = await generatePasskeyAuthenticationOptions();
  const authToken = jwt.sign(
    { challenge: options.challenge, stage: 'webauthn_authentication_pending' },
    JWT_SECRET,
    { expiresIn: '60s' }
  );
  res.json({ options, authToken });
});

authRouter.post('/passkey/verify', loginLimiter, async (req, res) => {
  const { authToken, response } = req.body;

  let payload: { challenge: string; stage: string };
  try {
    payload = jwt.verify(authToken, JWT_SECRET) as typeof payload;
  } catch {
    return res.status(401).json({ error: 'invalid_or_expired_auth_token' });
  }
  if (payload.stage !== 'webauthn_authentication_pending') {
    return res.status(401).json({ error: 'invalid_auth_token' });
  }

  const result = await verifyPasskeyAuthentication(payload.challenge, response);
  if (!result.ok) {
    await logAudit({ userId: null, action: 'passkey_login_failed', detail: {}, sourceIp: req.ip });
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const user = await db.one(`SELECT must_change_password, disabled_at FROM users WHERE id = $1`, [result.userId]);
  if (user.disabled_at) {
    await logAudit({ userId: result.userId, action: 'login_failed', detail: { reason: 'disabled' }, sourceIp: req.ip });
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  // A passkey is inherently multi-factor — its own device unlock
  // (biometric or PIN) is the "something you are/know" alongside the
  // device itself as "something you have" — so this skips a separate
  // TOTP challenge entirely regardless of whether the account also has
  // TOTP enabled, the same way Google and other sites treat a passkey
  // as a complete sign-in on its own, not an alternative first factor
  // that still needs a second one stacked on top.
  const sessionToken = issueSessionToken(result.userId);
  await logAudit({ userId: result.userId, action: 'login_success', detail: { method: 'passkey' }, sourceIp: req.ip });
  res.json({ sessionToken, mustChangePassword: user.must_change_password });
});
