import { authenticator } from 'otplib';
import { encryptCredential, decryptCredential } from './vaultClient';

/**
 * Generates a new TOTP secret and returns both the raw secret (only ever
 * shown once, during enrollment, as a QR code) and its Vault-encrypted form
 * for storage in users.totp_secret_encrypted.
 */
export async function generateTotpEnrollment(username: string, instanceName: string) {
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(username, instanceName || 'Guac Access Suite', secret);
  const secretEncrypted = await encryptCredential(secret);
  return { otpauthUrl, secretEncrypted };
}

export async function verifyTotpCode(secretEncrypted: string, code: string): Promise<boolean> {
  const secret = await decryptCredential(secretEncrypted);
  return authenticator.verify({ token: code, secret });
}
