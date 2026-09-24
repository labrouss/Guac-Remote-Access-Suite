import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['tests-integration/**'], // those require Docker; run via `npm run test:integration`
    // A handful of modules read secrets from process.env at import time
    // (bookmarkProxy.ts's PROXY_SESSION_SECRET, notably) — this gives every
    // test run a consistent, harmless value rather than each test file
    // needing to set it individually or risking `undefined` if the real
    // .env isn't loaded in CI.
    env: {
      JWT_SECRET: 'test-only-secret-do-not-use-in-real-deployments'
    }
  }
});
