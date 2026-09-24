import path from 'path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * UNVERIFIED: written against testcontainers/@testcontainers/postgresql's
 * real type definitions (confirmed by reading the installed package's
 * .d.ts files directly rather than assumed), and it type-checks — but it
 * has never actually been run, because no Docker daemon has been available
 * anywhere in this project's history. Treat this file as a drafted
 * starting point, not a proven-working harness, until it's actually been
 * run once against a real Docker daemon. See docs/TESTING_PLAN.md's
 * "Blocking on Docker" section.
 *
 * guacd and Vault stay mocked even at this layer (per docs/TESTING_PLAN.md
 * — they're external services, not this codebase). Postgres is real,
 * migrated fresh via the same applyMigrations() function scripts/migrate.ts
 * uses in production, so a schema bug would actually surface here.
 */

let container: StartedPostgreSqlContainer | undefined;

export async function startTestDatabase() {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('guac_test')
    .withUsername('guac_test')
    .withPassword('guac_test')
    .start();

  process.env.POSTGRES_HOST = container.getHost();
  process.env.POSTGRES_PORT = String(container.getPort());
  process.env.POSTGRES_DB = container.getDatabase();
  process.env.POSTGRES_USER = container.getUsername();
  process.env.POSTGRES_PASSWORD = container.getPassword();

  // Required by various modules at import time (session cookie signing,
  // guacamole-lite token encryption, JWT signing) — dummy but well-formed
  // values, never real secrets.
  process.env.SESSION_SECRET = 'integration-test-session-secret';
  process.env.JWT_SECRET = 'integration-test-jwt-secret';
  process.env.GUAC_TOKEN_ENCRYPTION_KEY = '01234567890123456789012345678901'; // 32 bytes
  process.env.VAULT_ADDR = 'https://vault.invalid'; // never actually contacted — see installMockVaultFetch below
  process.env.VAULT_ROLE_ID = 'test-role';
  process.env.VAULT_SECRET_ID = 'test-secret';

  // db.ts reads these env vars at module-import time, so the app (and its
  // migrations) must be imported fresh AFTER the container is up and env
  // vars are set — see createTestApp() below.
  const { applyMigrations } = await import('../src/migrationRunner');
  const { db } = await import('../src/db');
  await applyMigrations(db, path.join(__dirname, '../../migrations'));

  return container;
}

export async function stopTestDatabase() {
  await container?.stop();
  container = undefined;
}

/**
 * Re-imports the app fresh so every module reading process.env at import
 * time (db.ts, vaultClient.ts, bookmarkProxy.ts's PROXY_SESSION_SECRET)
 * picks up the values set in startTestDatabase(). Call vi.resetModules()
 * in the calling test file's beforeEach/beforeAll before this, same
 * pattern as vaultClient.test.ts.
 */
export async function createTestApp() {
  const { createApp } = await import('../src/app');
  return createApp();
}

/**
 * Vault's Transit engine is mocked at the node-fetch boundary (same
 * pattern as vaultClient.test.ts) rather than run for real — per
 * docs/TESTING_PLAN.md, guacd and Vault stay external-service mocks even
 * in Layer 2. This "encryption" is reversible base64-free passthrough,
 * NOT real crypto — good enough to prove the app's own round-trip logic
 * (write → read → decrypt matches what was written), not a security
 * property of anything.
 */
export function installMockVaultFetch(fetchMock: { mockImplementation: (fn: any) => void }) {
  fetchMock.mockImplementation(async (url: string, options?: any) => {
    if (url.includes('/auth/approle/login')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ auth: { client_token: 'mock-vault-token', lease_duration: 3600 } })
      };
    }
    if (url.includes('/transit/encrypt/')) {
      const body = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ data: { ciphertext: `vault:v1:${body.plaintext}` } }) };
    }
    if (url.includes('/transit/decrypt/')) {
      const body = JSON.parse(options.body);
      const plaintext = body.ciphertext.replace(/^vault:v1:/, '');
      return { ok: true, status: 200, json: async () => ({ data: { plaintext } }) };
    }
    if (url.includes('/sys/health')) {
      return { ok: true, status: 200 };
    }
    throw new Error(`installMockVaultFetch: unexpected URL in integration test: ${url}`);
  });
}
