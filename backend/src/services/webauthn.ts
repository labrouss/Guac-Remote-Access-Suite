import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { db } from '../db';

/**
 * RP ID must be a bare domain — no scheme, no port, no path — and must
 * exactly match (or be a registrable-domain suffix of) whatever origin
 * the browser actually made the request from; a mismatch fails everyt
 * ceremony's verification outright, not with an ambiguous error.
 * Derived from PUBLIC_URL (already required, see .env.example's own
 * comment on why this has to reflect where the app is actually reached)
 * rather than a separate config value — one source of truth for "what
 * domain is this app on," not two that could drift apart.
 */
const publicUrl = new URL(process.env.PUBLIC_URL || 'http://localhost');
const RP_ID = publicUrl.hostname;
const RP_NAME = 'Guac Access Suite';
const ORIGIN = publicUrl.origin;

interface StoredCredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: string; // bigint comes back as a string from pg
  transports: string[] | null;
}

export async function generatePasskeyRegistrationOptions(userId: string, username: string) {
  const existing = await db.manyOrNone<{ credential_id: string; transports: string[] | null }>(
    `SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1`,
    [userId]
  );

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: username,
    // Excluding what's already registered stops someone from re-registering
    // the same physical passkey twice under the same account — the browser
    // itself refuses to proceed (rather than this app finding out only
    // after the fact) once it recognizes one of these as already known.
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports ?? undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
  });

  return options;
}

export async function verifyAndStorePasskeyRegistration(
  userId: string,
  expectedChallenge: string,
  response: RegistrationResponseJSON,
  name: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID
    });
  } catch {
    return { ok: false, message: 'Could not verify this passkey.' };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, message: 'Could not verify this passkey.' };
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  await db.none(
    `INSERT INTO webauthn_credentials
       (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      userId,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports ?? null,
      credentialDeviceType,
      credentialBackedUp,
      name
    ]
  );
  return { ok: true };
}

/**
 * Deliberately no `allowCredentials` — this is the "usernameless" flow
 * the person asked for by name ("like Google and some sites do"): the
 * authenticator itself surfaces whichever passkeys it holds for this
 * origin, with nobody having typed a username first. Which real user
 * that turns out to be is only known once the response comes back with
 * a specific credential ID in it — see verifyPasskeyAuthentication.
 */
export async function generatePasskeyAuthenticationOptions() {
  return generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred' });
}

export async function verifyPasskeyAuthentication(
  expectedChallenge: string,
  response: AuthenticationResponseJSON
): Promise<{ ok: true; userId: string } | { ok: false }> {
  const row = await db.oneOrNone<StoredCredentialRow>(
    `SELECT id, user_id, credential_id, public_key, counter, transports FROM webauthn_credentials WHERE credential_id = $1`,
    [response.id]
  );
  if (!row) return { ok: false };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: Number(row.counter),
        transports: row.transports ?? undefined
      }
    });
  } catch {
    return { ok: false };
  }
  if (!verification.verified) return { ok: false };

  // Counter updated on every successful login, not just written once at
  // registration — this is the actual replay-detection mechanism
  // (verifyAuthenticationResponse itself already rejects a response
  // whose counter doesn't exceed what's stored, but only if what's
  // stored is kept current).
  await db.none(
    `UPDATE webauthn_credentials SET counter = $1, last_used_at = now() WHERE id = $2`,
    [verification.authenticationInfo.newCounter, row.id]
  );

  return { ok: true, userId: row.user_id };
}

export async function listPasskeysForUser(userId: string) {
  return db.manyOrNone(
    `SELECT id, name, device_type, backed_up, created_at, last_used_at
     FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );
}

/** Scoped to userId so one account can never delete another's passkey by guessing an id. */
export async function deletePasskey(userId: string, credentialRowId: string): Promise<boolean> {
  const result = await db.result(
    `DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2`,
    [credentialRowId, userId]
  );
  return result.rowCount > 0;
}
