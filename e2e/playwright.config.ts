import { defineConfig } from '@playwright/test';

/**
 * DRAFTED, UNVERIFIED — see docs/TESTING_PLAN.md's Layer 3 section.
 * Assumes docker-compose.test.yml is already up (frontend on :5173,
 * backend on :8080) — this config does not start the stack itself.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false, // tests share one running stack; a fresh instance isn't spun up per test
  workers: 1, // the seven flows below build on shared state (one setup run, one admin account) — must run in order, not across parallel workers
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
