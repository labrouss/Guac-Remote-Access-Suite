import fetch from 'node-fetch';

const VAULT_ADDR = process.env.VAULT_ADDR;
const TRANSIT_KEY = 'guac-credentials';

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * AppRole login. Called lazily and re-called whenever the cached token
 * is close to expiring, so the app never holds a long-lived static token.
 */
async function getVaultToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await fetch(`${VAULT_ADDR}/v1/auth/approle/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role_id: process.env.VAULT_ROLE_ID,
      secret_id: process.env.VAULT_SECRET_ID
    })
  });

  if (!res.ok) throw new Error(`Vault AppRole login failed: ${res.status}`);
  const data = await res.json();

  // Assigned to a local first, not just narrowed from cachedToken directly —
  // TS can't carry a "just assigned, so it's non-null" narrowing for a
  // module-level `let` across an async function boundary (a concurrent call
  // could reassign it in between), so returning cachedToken itself here
  // would still type as `string | null`.
  const token = data.auth.client_token as string;
  cachedToken = token;
  // Refresh a little before actual expiry
  tokenExpiresAt = Date.now() + (data.auth.lease_duration - 60) * 1000;
  return token;
}

export async function checkVaultHealth(vaultAddr: string): Promise<boolean> {
  try {
    const res = await fetch(`${vaultAddr}/v1/sys/health`);
    // Vault returns 200 (unsealed+active), 429 (standby), or 473/501/503 depending on state.
    // Any response at all means it's reachable; only a network failure should fail this check.
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function encryptCredential(plaintext: string): Promise<string> {
  const token = await getVaultToken();
  const res = await fetch(`${VAULT_ADDR}/v1/transit/encrypt/${TRANSIT_KEY}`, {
    method: 'POST',
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plaintext: Buffer.from(plaintext).toString('base64') })
  });
  if (!res.ok) throw new Error(`Vault encrypt failed: ${res.status}`);
  const data = await res.json();
  return data.data.ciphertext; // "vault:v1:...."
}

export async function decryptCredential(ciphertext: string): Promise<string> {
  const token = await getVaultToken();
  const res = await fetch(`${VAULT_ADDR}/v1/transit/decrypt/${TRANSIT_KEY}`, {
    method: 'POST',
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ciphertext })
  });
  if (!res.ok) throw new Error(`Vault decrypt failed: ${res.status}`);
  const data = await res.json();
  return Buffer.from(data.data.plaintext, 'base64').toString('utf8');
}
