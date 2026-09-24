import { test, expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';

/**
 * DRAFTED, UNVERIFIED — see docs/TESTING_PLAN.md's Layer 3 section. Never
 * run against a real browser or the actual docker-compose.test.yml stack.
 * Selectors below were written against the real component source
 * (label text, button text, class names) rather than guessed, but "matches
 * the source" and "actually renders and behaves this way in a browser"
 * are different levels of confidence — this file is the former, not yet
 * the latter.
 *
 * Structured as ONE continuous journey (test.describe.serial), not seven
 * independent tests, because the flows genuinely share state: one setup
 * wizard run produces the one admin account every later step depends on.
 * Playwright's serial mode stops the whole file on the first failure
 * rather than limping through with unrelated state — the right behavior
 * here, since step 3 failing makes steps 4-7 meaningless anyway.
 *
 * Steps 5-7 are left as test.fixme() with an explanation rather than
 * fabricated passing assertions — see each step's comment for exactly
 * what's missing (SSH connection creation via the admin UI, credential
 * assignment, and second-user demo-grant verification aren't scripted
 * yet). Marking them honestly as incomplete is more useful to whoever
 * picks this up than a test that looks complete but was never exercised.
 */

test.describe.serial('full application journey', () => {
  let page: Page;
  let totpSecret: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('1. fresh instance shows the setup wizard, completes, and lands on login', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Set up Guac Access Suite' })).toBeVisible();

    await page.getByLabel('Instance name').fill('E2E Test Instance');
    await page.getByLabel('Admin username').fill('admin');
    await page.getByLabel('Admin password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Continue' }).click();

    // TOTP enrollment: extract the real secret from the rendered otpauth://
    // URL and compute a genuinely valid code, same approach as the Layer 2
    // setup wizard integration test.
    await expect(page.locator('.otpauth-url')).toBeVisible();
    const otpauthUrl = await page.locator('.otpauth-url').textContent();
    const secretMatch = /secret=([A-Z0-9]+)/.exec(otpauthUrl ?? '');
    expect(secretMatch).toBeTruthy();
    totpSecret = secretMatch![1];

    await page.getByLabel('6-digit code').fill(authenticator.generate(totpSecret));
    await page.getByRole('button', { name: 'Verify' }).click();

    await expect(page.getByLabel('Vault address')).toBeVisible();
    await page.getByLabel('Vault address').fill('http://vault:8200');
    await page.getByRole('button', { name: 'Test connection' }).click();

    await expect(page.getByRole('button', { name: 'Finish setup' })).toBeVisible();
    await page.getByRole('button', { name: 'Finish setup' }).click();

    await expect(page).toHaveURL(/\/login/);
  });

  test('2. login with password + TOTP lands on the main app', async () => {
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByLabel('6-digit authenticator code')).toBeVisible();
    await page.getByLabel('6-digit authenticator code').fill(authenticator.generate(totpSecret));
    await page.getByRole('button', { name: 'Verify' }).click();

    await expect(page.getByText('Guac Access Suite')).toBeVisible(); // MainApp header
  });

  test("3. add a connection and a direct bookmark to the admin's personal list, open the bookmark in a new tab", async () => {
    await page.locator('.panel-trigger').hover();
    await expect(page.getByText('My Connections')).toBeVisible();
    await page.getByText('My Connections').click();

    await page.getByRole('button', { name: '+ Add' }).click();
    await page.getByPlaceholder('Name').fill('Example Site');
    await page.getByPlaceholder('https://...').fill('https://example.com');
    await page.getByRole('button', { name: 'Save' }).click();

    const [newTab] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByRole('button', { name: 'Example Site' }).click()
    ]);
    await newTab.waitForLoadState();
    expect(newTab.url()).toContain('example.com');
    await newTab.close();
  });

  test('4. a proxied bookmark pointing at the internal-only test host is actually reachable through the proxy path', async () => {
    await page.getByRole('button', { name: '+ Add' }).click();
    await page.getByPlaceholder('Name').fill('Internal Tool');
    // internal-test-http is only reachable on the compose network, not from
    // wherever Playwright's browser runs — this specifically verifies the
    // proxy path, not just that direct bookmarks work (already covered above).
    await page.getByPlaceholder('https://...').fill('http://internal-test-http');
    await page.getByRole('combobox').selectOption('proxied');
    await page.getByRole('button', { name: 'Save' }).click();

    const [proxiedTab] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByRole('button', { name: 'Internal Tool' }).click()
    ]);
    await proxiedTab.waitForLoadState();
    // The marker element from e2e/fixtures/internal-page.html — only
    // visible if the proxy actually forwarded the request successfully.
    await expect(proxiedTab.locator('#marker')).toHaveText('internal-only-host-reachable');
    await proxiedTab.close();
  });

  test('5. an SSH connection against the disposable SSH target renders a terminal and accepts input', async () => {
    test.fixme(true, 'SSH connection creation + credential assignment via UI not yet scripted in this draft');
  });

  test('6. starting and stopping a recording produces something playable', async () => {
    test.fixme(true, 'Depends on test 5 having a live session to record; scaffold once test 5 is complete');
  });

  test("7. a demo granted to a second user shows exactly that demo's items", async () => {
    await page.getByRole('button', { name: 'Demos' }).click();
    await page.getByPlaceholder('slug (e.g. veeamdemo)').fill('e2e-demo');
    await page.getByPlaceholder('Title').fill('E2E Demo');
    await page.getByRole('button', { name: 'Create demo' }).click();

    test.fixme(
      true,
      'Item-adding and second-user grant/verification not yet scripted — needs the admin panel user-creation flow wired in first'
    );
  });
});
