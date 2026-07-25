/**
 * tests/auth-e2e.spec.js — cross-browser end-to-end auth regression suite.
 *
 * This file is the browser-layer counterpart to the api/cron synthetic robots.
 * Where the robots prove the *backend* auth surface, these specs prove the
 * *page* surface — across Chromium, Firefox AND WebKit (see the *-auth projects
 * in playwright.config.js). Every Supabase call is intercepted at the network
 * layer, so the suite is deterministic and hits no real backend.
 *
 * Coverage:
 *   A. OAuth misland sentinel  — the exact production bug: an OAuth/OTP token
 *      that lands on the wrong page must be detected and forwarded to
 *      /auth-callback.html (js/oauth-sentinel.js). This is the regression test
 *      the original outage lacked.
 *   B. Signin happy path       — mocked successful login renders the success
 *      state, in every browser.
 *   C. Signin error catalog    — bad credentials, network failure, and
 *      client-side validation each render the right error UI.
 *
 * Run one browser:  npx playwright test tests/auth-e2e.spec.js --project=chromium
 * Run all three:    npx playwright test tests/auth-e2e.spec.js
 */

import { test, expect } from '@playwright/test';

// ── Mock Supabase identities ─────────────────────────────────────────────────
const USER_ID = '00000000-0000-0000-0000-0000000abcde';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
// supabase-js stores the access_token verbatim and may decode it for the `sub`;
// a structurally-valid (unsigned) JWT keeps it happy without a real secret.
const fakeJwt = (sub) =>
    `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, role: 'authenticated', aud: 'authenticated', exp: 9999999999 })}.sig`;

const mockUser = {
    id: USER_ID, aud: 'authenticated', role: 'authenticated',
    email: 'e2e@playwright.test',
    user_metadata: { full_name: 'E2E User' },
    app_metadata: { provider: 'email' },
};
const mockSession = {
    access_token: fakeJwt(USER_ID), token_type: 'bearer',
    expires_in: 3600, expires_at: 9999999999, refresh_token: 'fake-refresh-token',
    user: mockUser,
};
const mockProfileRow = {
    id: USER_ID, email: 'e2e@playwright.test', plan: 'free', role: 'user', full_name: 'E2E User',
};

const json = (obj, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(obj) });

/**
 * Intercept every Supabase call so no test touches the real backend.
 * `tokenResult` decides what the password-grant returns:
 *   'success'  → 200 session
 *   'badcreds' → 400 invalid_grant
 *   'network'  → aborted connection
 */
async function stubSupabase(page, { tokenResult = 'success' } = {}) {
    // CRITICAL ordering: Playwright matches routes in REVERSE registration
    // order, so this telemetry catch-all must be registered FIRST or it
    // shadows every specific mock below it. Registered last (as it was until
    // 2026-07), it answered the password grant with `{}` — supabase-js then
    // resolved with no session and no error, the signin page silently stayed
    // put, and the happy-path spec failed in all three browsers on every run
    // since the suite was introduced.
    await page.route('**/auth/v1/**', (route) => route.fulfill(json({})));

    await page.route('**/auth/v1/token**', (route) => {
        if (tokenResult === 'network') return route.abort();
        if (tokenResult === 'badcreds') {
            return route.fulfill(json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400));
        }
        return route.fulfill(json(mockSession));
    });
    await page.route('**/auth/v1/user**', (route) => route.fulfill(json(mockUser)));
    await page.route('**/auth/v1/logout**', (route) => route.fulfill({ status: 204, body: '' }));
    await page.route('**/rest/v1/user_profiles**', (route) => route.fulfill(json([mockProfileRow])));
    // effective_plan_for + any other RPC — non-fatal in app code, stubbed for quiet.
    await page.route('**/rest/v1/rpc/**', (route) => route.fulfill(json('free')));
}

// ─────────────────────────────────────────────────────────────────────────────
// A. OAuth misland sentinel — the regression test for the original outage
// ─────────────────────────────────────────────────────────────────────────────
/*
 * WAIT STRATEGY — read before changing any goto() in this block.
 *
 * page.goto() defaults to waitUntil:'load'. That default is WRONG for these
 * specs and caused a long-running CI flake (e2e-auth red on main 2026-07-21
 * and 07-24, and on PR #957, always the same webkit-auth spec):
 *
 *   Error: page.goto: Test timeout of 60000ms exceeded.
 *     - navigating to ".../space-weather.html#error=access_denied", waiting until "load"
 *
 * The sentinel exists to navigate AWAY from the page under test. It runs when
 * nav.js's module graph evaluates (before DOMContentLoaded) and then calls
 * location.replace() 200ms later. The pages it lands on are heavy — measured
 * locally, `load` fires at ~5.6s on space-weather.html and ~19s on index.html,
 * while the bounce happens at ~1.1s. So the original document is ALWAYS torn
 * down mid-load and its `load` event never fires. Asking goto() to wait for
 * that event is asking for something the feature guarantees will not happen.
 *
 * Chromium and Firefox resolve the interrupted navigation against the new
 * document and move on; WebKit does not, so goto() hung for the full 60s test
 * timeout. It looked intermittent only because it depends on whether `load`
 * happens to beat the 200ms timer — on a fast runner it sometimes did.
 *
 * So: assert on the outcome (the URL we bounce to), never on a lifecycle
 * event of a document we are deliberately destroying.
 *   - Redirect-expected specs use waitUntil:'commit' — resolve as soon as the
 *     response lands; waitForURL below is the real assertion.
 *   - The redirect-NOT-expected spec uses 'domcontentloaded' instead, because
 *     "it stayed put" is only meaningful once the sentinel has actually had a
 *     chance to run. ES modules evaluate before DOMContentLoaded, so that
 *     event is the earliest point where a non-redirect proves anything; with
 *     'commit' the assertion would pass vacuously against a blank document.
 *
 * The waitForURL budget is 30s rather than 10s: 'commit' returns before the
 * module graph has evaluated, so this timeout now covers the sentinel's whole
 * startup path (nav.js → oauth-sentinel.js → telemetry.js + auth-funnel.js)
 * on a cold, contended CI runner, which the old 10s no longer masks.
 */
const BOUNCE = /\/auth-callback\.html\?from=recovered_misland/;
const BOUNCE_TIMEOUT = 30_000;

test.describe('OAuth misland sentinel', () => {
    test.beforeEach(async ({ page }) => { await stubSupabase(page); });

    test('an access_token landing on the root is forwarded to /auth-callback', async ({ page }) => {
        const hash = '#access_token=' + fakeJwt(USER_ID) +
            '&refresh_token=fake-refresh-token&token_type=bearer&expires_in=3600';
        await page.goto('/' + hash, { waitUntil: 'commit' });
        await page.waitForURL(BOUNCE, { timeout: BOUNCE_TIMEOUT });
        // The token payload must survive the bounce so the callback can use it.
        expect(page.url()).toContain('access_token');
    });

    test('an OAuth error landing on a normal page is forwarded too', async ({ page }) => {
        await page.goto('/space-weather.html#error=access_denied&error_description=User+cancelled',
            { waitUntil: 'commit' });
        await page.waitForURL(BOUNCE, { timeout: BOUNCE_TIMEOUT });
        expect(page.url()).toContain('error=access_denied');
    });

    test('a plain in-page anchor is NOT treated as an auth payload', async ({ page }) => {
        // 'domcontentloaded' — not 'commit' — so the sentinel has demonstrably
        // run by the time we assert it did nothing. See the note above.
        await page.goto('/#features', { waitUntil: 'domcontentloaded' });
        // Give the sentinel its 200ms window and then some — it must stay put.
        await page.waitForTimeout(1000);
        expect(page.url()).not.toContain('auth-callback');
        expect(page.url()).toContain('#features');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Signin happy path
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Signin happy path', () => {
    test('valid credentials reach the signed-in state', async ({ page }) => {
        await stubSupabase(page, { tokenResult: 'success' });
        await page.goto('/signin.html');
        await page.fill('#email', 'e2e@playwright.test');
        await page.fill('#password', 'CorrectHorse9!');
        await page.click('#btn-submit');

        // Success either flips on the #login-success panel or has already
        // redirected away from /signin — accept whichever the browser reaches.
        await expect(async () => {
            const successShown = await page.locator('#login-success').isVisible().catch(() => false);
            const leftSignin = !page.url().includes('signin');
            expect(successShown || leftSignin).toBeTruthy();
        }).toPass({ timeout: 10_000 });

        // And the error field must NOT have been raised.
        await expect(page.locator('#err-pw')).not.toHaveClass(/visible/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Signin error catalog
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Signin error catalog', () => {
    test('wrong credentials render the inline error', async ({ page }) => {
        await stubSupabase(page, { tokenResult: 'badcreds' });
        await page.goto('/signin.html');
        await page.fill('#email', 'e2e@playwright.test');
        await page.fill('#password', 'wrong-password');
        await page.click('#btn-submit');
        await expect(page.locator('#err-pw')).toHaveClass(/visible/, { timeout: 10_000 });
        // The button must recover (re-enabled) so the user can retry.
        await expect(page.locator('#btn-submit')).toBeEnabled();
    });

    test('a network failure still surfaces an error (no silent hang)', async ({ page }) => {
        await stubSupabase(page, { tokenResult: 'network' });
        await page.goto('/signin.html');
        await page.fill('#email', 'e2e@playwright.test');
        await page.fill('#password', 'CorrectHorse9!');
        await page.click('#btn-submit');
        await expect(page.locator('#err-pw')).toHaveClass(/visible/, { timeout: 10_000 });
        await expect(page.locator('#btn-submit')).toBeEnabled();
    });

    test('invalid email format is caught client-side before any request', async ({ page }) => {
        let tokenCalled = false;
        await page.route('**/auth/v1/token**', (route) => { tokenCalled = true; route.fulfill(json(mockSession)); });
        await page.goto('/signin.html');
        await page.fill('#email', 'not-an-email');
        await page.fill('#password', 'whatever123');
        await page.click('#btn-submit');
        await expect(page.locator('#err-email')).toHaveClass(/visible/);
        expect(tokenCalled).toBe(false);
    });

    test('empty password is caught client-side', async ({ page }) => {
        await page.goto('/signin.html');
        await page.fill('#email', 'e2e@playwright.test');
        await page.click('#btn-submit');
        await expect(page.locator('#err-pw')).toHaveClass(/visible/);
    });
});
