import crypto from 'crypto';
import { deriveGuacTokenKey } from './guacTokenKey';

/**
 * Encrypts a payload exactly the way guacamole-lite's own internal
 * lib/Crypt.js expects to decrypt it — verified by testing against the
 * real installed 1.2.0 package directly (not assumed from documentation).
 * This is NOT the same format the app's own token encryption used before:
 * the previous version omitted the outer base64 wrapping around the final
 * `{iv, value}` JSON object, confirmed to fail outright against 1.2.0's
 * real Crypt.decrypt() — which would have broken every connection attempt
 * immediately after the version upgrade if left unfixed.
 *
 * `Crypt` isn't part of guacamole-lite's public API surface (its main
 * entry point only exports `Server`), so this replicates the algorithm
 * explicitly rather than reaching into the package's internal file paths,
 * which could change between versions without a semver-major bump.
 */
export function encryptGuacToken(payload: object): string {
  // deriveGuacTokenKey(), not a naive Buffer.from(...).subarray(0, 32) of
  // the raw env var (this function's own previous approach) — see that
  // helper's own comment for the full story: guacamole-lite's real Crypt
  // class does zero transformation of its own configured key, so if the
  // two sides derived the key differently, they'd silently disagree
  // whenever the raw env var wasn't exactly 32 bytes. Confirmed
  // empirically against the real installed package, not assumed.
  const key = deriveGuacTokenKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

  // Binary/latin1 intermediate encoding, then base64 — matches Crypt.js's
  // encrypt() exactly, byte for byte, confirmed by round-tripping through
  // the real installed Crypt.decrypt().
  let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'binary');
  encrypted += cipher.final('binary');

  const data = {
    iv: iv.toString('base64'),
    value: Buffer.from(encrypted, 'binary').toString('base64')
  };

  // The whole {iv, value} object gets base64-encoded again as the outer
  // wrapper — this second wrapping is the exact part the previous version
  // of this function omitted.
  return Buffer.from(JSON.stringify(data)).toString('base64');
}
