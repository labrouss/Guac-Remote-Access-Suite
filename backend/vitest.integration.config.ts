import { defineConfig } from 'vitest/config';

/**
 * Separate from vitest.config.ts deliberately: these tests need a real
 * Docker daemon (testcontainers spins up an ephemeral Postgres per file)
 * and take genuinely longer to run, so they must never be picked up by the
 * fast `npm test` unit suite that CI runs on every push. Run explicitly via
 * `npm run test:integration` once Docker is available — see
 * docs/TESTING_PLAN.md's "Blocking on Docker" section for current status.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests-integration/**/*.integration.test.ts'],
    testTimeout: 60_000, // container startup can genuinely take a while
    hookTimeout: 60_000,
    env: {
      JWT_SECRET: 'test-only-secret-do-not-use-in-real-deployments'
    }
  }
});
