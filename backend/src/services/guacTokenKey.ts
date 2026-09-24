import crypto from 'crypto';

/**
 * Derives a guaranteed-exactly-32-byte AES-256 key from
 * GUAC_TOKEN_ENCRYPTION_KEY, via SHA-256 (which always produces exactly
 * 32 bytes of output regardless of input length) — rather than trusting
 * the raw env var to already be exactly 32 bytes long, or truncating it
 * naively.
 *
 * Found as a real, confirmed bug via a live deployment: `Buffer.from(key,
 * 'utf8').subarray(0, 32)` (this function's previous approach, still used
 * on the encrypt side only, in guacToken.ts) silently produces a
 * DIFFERENT key than what guacamole-lite's own Crypt class actually uses
 * — its `key` is passed straight to `Crypto.createDecipheriv()` with zero
 * transformation of its own. If the raw env var isn't exactly 32
 * characters (verified directly against .env.example's own placeholder,
 * which is 36), decryption inside guacamole-lite throws "Invalid key
 * length" — confirmed empirically against the real installed package,
 * not assumed. guacamole-lite's own code catches this without crashing
 * (routes/setup.ts and similar have their own, separate crash-safety
 * story — this isn't that), but every single connection attempt failed
 * silently from the browser's perspective, with nothing in this app's
 * own logs pointing at the actual cause.
 *
 * Hashing instead of truncating/trusting fixes this properly rather than
 * just telling operators to be more careful generating the env var: this
 * derives the *same* 32 bytes on both sides regardless of the raw
 * value's actual length, so the whole class of bug can't recur even if a
 * future .env value is some other length again.
 */
export function deriveGuacTokenKey(): Buffer {
  return crypto.createHash('sha256').update(process.env.GUAC_TOKEN_ENCRYPTION_KEY!).digest();
}
