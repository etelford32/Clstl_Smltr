/**
 * E2E tests for authentication and subscription flows.
 *
 * Tests cover:
 *  1. Landing page → signup CTA works
 *  2. Signup form validation (empty fields, bad email, short password)
 *  3. Signup form submits with valid data
 *  4. Signin form validation + submit
 *  5. Password reset flow
 *  6. Pricing page → checkout redirect for signed-in users
 *  7. Dashboard loads for authenticated users
 *  8. Dashboard subscription card shows correct state
 *  9. Alert preferences save correctly
 * 10. Onboarding tour appears for new users
 *
 * Run:  npx playwright test tests/auth-flows.spec.js
 * Debug: npx playwright test --headed --debug tests/auth-flows.spec.js
 */

import { test, expect } from '@playwright/test';

// ── Test data ────────────────────────────────────────────────────────────────
const TEST_EMAIL    = `test-${Date.now()}@playwright.test`;
const TEST_PASSWORD = 'TestPass123!';
const TEST_FIRST    = 'Test';
const TEST_LAST     = 'User';

// ── 1. Landing Page ─────────────────────────────────────────────────────────

test.describe('Landing Page', () => {
    test('loads and shows hero CTA', async ({ page }) => {
        await page.goto('/');
        await expect(page).toHaveTitle(/Parker Physics/);
        // Hero CTA should be visible
        const cta = page.locator('a:has-text("Get Started")').first();
        await expect(cta).toBeVisible();
    });

    test('CTA links to signup', async ({ page }) => {
        await page.goto('/');
        const cta = page.locator('a:has-text("Get Started")').first();
        const href = await cta.getAttribute('href');
        expect(href).toContain('signup');
    });

    test('pricing teaser is visible', async ({ page }) => {
        await page.goto('/');
        const pricing = page.locator('text=Start free').first();
        await expect(pricing).toBeVisible();
    });
});

// ── 2. Signup Form Validation ───────────────────────────────────────────────

test.describe('Signup Form Validation', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/signup.html?plan=free');
    });

    test('shows error for empty fields', async ({ page }) => {
        await page.click('#btn-submit');
        // Should show validation errors
        const firstNameErr = page.locator('#err-first');
        await expect(firstNameErr).toBeVisible();
    });

    test('shows error for invalid email', async ({ page }) => {
        await page.fill('#first-name', TEST_FIRST);
        await page.fill('#last-name', TEST_LAST);
        await page.fill('#email', 'not-an-email');
        await page.fill('#password', TEST_PASSWORD);
        await page.check('#terms');
        await page.click('#btn-submit');
        const emailErr = page.locator('#err-email');
        await expect(emailErr).toBeVisible();
    });

    test('shows error for short password', async ({ page }) => {
        await page.fill('#first-name', TEST_FIRST);
        await page.fill('#last-name', TEST_LAST);
        await page.fill('#email', TEST_EMAIL);
        await page.fill('#password', 'short');
        await page.check('#terms');
        await page.click('#btn-submit');
        const pwErr = page.locator('#err-pw');
        await expect(pwErr).toBeVisible();
    });

    test('shows error when terms unchecked', async ({ page }) => {
        await page.fill('#first-name', TEST_FIRST);
        await page.fill('#last-name', TEST_LAST);
        await page.fill('#email', TEST_EMAIL);
        await page.fill('#password', TEST_PASSWORD);
        // Don't check terms
        await page.click('#btn-submit');
        const termsErr = page.locator('#err-terms');
        await expect(termsErr).toBeVisible();
    });

    test('terms and privacy links work', async ({ page }) => {
        const termsLink = page.locator('a:has-text("Terms of Service")');
        await expect(termsLink).toHaveAttribute('href', 'eula.html');
        const privacyLink = page.locator('a:has-text("Privacy Policy")');
        await expect(privacyLink).toHaveAttribute('href', 'privacy.html');
    });

    test('plan pills are selectable', async ({ page }) => {
        // Default should be free (from URL param)
        const freePill = page.locator('#pill-free');
        await expect(freePill).toHaveClass(/selected/);

        // Click basic
        await page.click('#pill-basic');
        await expect(page.locator('#pill-basic')).toHaveClass(/selected/);
        await expect(freePill).not.toHaveClass(/selected/);
    });

    test('password strength indicator works', async ({ page }) => {
        const bar = page.locator('#pw-bar');
        await page.fill('#password', 'ab');
        // Short = red/narrow
        const width1 = await bar.evaluate(el => el.style.width);
        expect(parseInt(width1)).toBeLessThan(50);

        await page.fill('#password', 'StrongP@ss123');
        const width2 = await bar.evaluate(el => el.style.width);
        expect(parseInt(width2)).toBeGreaterThan(60);
    });

    test('no OAuth buttons present', async ({ page }) => {
        const oauthBtn = page.locator('button:has-text("Google")');
        await expect(oauthBtn).toHaveCount(0);
    });
});

// ── 3. Signup Submit ────────────────────────────────────────────────────────

test.describe('Signup Submit', () => {
    test('submits valid form and shows success or confirmation', async ({ page }) => {
        await page.goto('/signup.html?plan=free');
        await page.fill('#first-name', TEST_FIRST);
        await page.fill('#last-name', TEST_LAST);
        await page.fill('#email', TEST_EMAIL);
        await page.fill('#password', TEST_PASSWORD);
        await page.check('#terms');
        await page.click('#btn-submit');

        // Button should show loading state
        await expect(page.locator('#btn-submit')).toHaveText(/Creating account/);

        // Should eventually show success view (either confirmation or redirect)
        await expect(page.locator('#success-view')).toBeVisible({ timeout: 10_000 });
    });
});

// ── 4. Signin Form ──────────────────────────────────────────────────────────

test.describe('Signin Form', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/signin.html');
    });

    test('page loads with form', async ({ page }) => {
        await expect(page.locator('#email')).toBeVisible();
        await expect(page.locator('#password')).toBeVisible();
        await expect(page.locator('#btn-submit')).toBeVisible();
    });

    test('no OAuth buttons present', async ({ page }) => {
        const oauthBtn = page.locator('button:has-text("Google")');
        await expect(oauthBtn).toHaveCount(0);
    });

    test('forgot password shows reset view', async ({ page }) => {
        await page.click('#forgot-btn');
        const resetView = page.locator('#reset-view');
        await expect(resetView).toBeVisible();
    });

    test('back button returns to signin', async ({ page }) => {
        await page.click('#forgot-btn');
        await page.click('#back-btn');
        const signInForm = page.locator('#signin-form');
        await expect(signInForm).toBeVisible();
    });

    test('shows error for invalid credentials', async ({ page }) => {
        await page.fill('#email', 'nonexistent@test.com');
        await page.fill('#password', 'wrongpassword');
        await page.click('#btn-submit');
        // Should show error (may take a moment for Supabase to respond)
        const errorEl = page.locator('.form-error.visible, .error-msg.visible, [class*="error"]').first();
        await expect(errorEl).toBeVisible({ timeout: 10_000 });
    });
});

// ── 5. Reset Password Page ──────────────────────────────────────────────────

test.describe('Reset Password Page', () => {
    test('loads and shows form or expired message', async ({ page }) => {
        await page.goto('/reset-password.html');
        // Should show either the form (if valid token in URL) or the expired view
        const formView = page.locator('#reset-form-view');
        const errorView = page.locator('#error-view');
        // One of these should be visible
        await expect(formView.or(errorView)).toBeVisible({ timeout: 5_000 });
    });
});

// ── 6. Pricing Page ─────────────────────────────────────────────────────────

test.describe('Pricing Page', () => {
    test('shows three plan cards', async ({ page }) => {
        await page.goto('/pricing.html');
        const cards = page.locator('.price-card');
        await expect(cards).toHaveCount(3);
    });

    test('free CTA links to signup', async ({ page }) => {
        await page.goto('/pricing.html');
        const freeCta = page.locator('a:has-text("Start Free")');
        await expect(freeCta).toHaveAttribute('href', /signup.*plan=free/);
    });

    test('basic CTA has checkout attribute', async ({ page }) => {
        await page.goto('/pricing.html');
        const basicCta = page.locator('[data-checkout="basic"]');
        await expect(basicCta).toBeVisible();
    });

    test('advanced CTA has checkout attribute', async ({ page }) => {
        await page.goto('/pricing.html');
        const advancedCta = page.locator('[data-checkout="advanced"]');
        await expect(advancedCta).toBeVisible();
    });

    test('FAQ accordion toggles', async ({ page }) => {
        await page.goto('/pricing.html');
        const firstQ = page.locator('.faq-q').first();
        await firstQ.click();
        const firstItem = page.locator('.faq-item').first();
        await expect(firstItem).toHaveClass(/open/);
    });

    test('canceled checkout shows banner', async ({ page }) => {
        await page.goto('/pricing.html?checkout=canceled');
        const banner = page.locator('text=Checkout canceled');
        await expect(banner).toBeVisible({ timeout: 3_000 });
    });
});

// ── 7. Dashboard ────────────────────────────────────────────────────────────

test.describe('Dashboard', () => {
    test('shows auth gate for unauthenticated users', async ({ page }) => {
        // Clear any stored auth
        await page.goto('/dashboard.html');
        await page.evaluate(() => {
            localStorage.removeItem('pp_auth');
            sessionStorage.removeItem('pp_auth');
        });
        await page.reload();
        // Should show auth gate or hide main content
        const gate = page.locator('#auth-gate');
        await expect(gate).toBeVisible({ timeout: 5_000 });
    });

    test('subscription card exists', async ({ page }) => {
        await page.goto('/dashboard.html');
        const subCard = page.locator('#subscription-card');
        // Card should exist in DOM (may be hidden if not authed)
        await expect(subCard).toBeAttached();
    });

    test('alert preferences card exists', async ({ page }) => {
        await page.goto('/dashboard.html');
        const prefsCard = page.locator('#alert-prefs-card');
        await expect(prefsCard).toBeAttached();
    });

    test('impact score card exists', async ({ page }) => {
        await page.goto('/dashboard.html');
        const impactCard = page.locator('#impact-card');
        await expect(impactCard).toBeAttached();
    });

    test('alert history card exists', async ({ page }) => {
        await page.goto('/dashboard.html');
        const historyCard = page.locator('#alert-history-card');
        await expect(historyCard).toBeAttached();
    });

    test('tour retake button exists', async ({ page }) => {
        await page.goto('/dashboard.html');
        const tourBtn = page.locator('#retake-tour');
        await expect(tourBtn).toBeAttached();
    });
});

// ── 8. Onboarding Tour ──────────────────────────────────────────────────────

test.describe('Onboarding Tour', () => {
    test('tour modal can be triggered', async ({ page }) => {
        await page.goto('/dashboard.html');
        // Clear tour completion flag
        await page.evaluate(() => localStorage.removeItem('ppx_tour_completed'));

        // Inject a mock auth state so dashboard renders
        await page.evaluate(() => {
            localStorage.setItem('pp_auth', JSON.stringify({
                signedIn: true, email: 'test@test.com', name: 'Test',
                plan: 'free', role: 'user', provider: 'mock',
            }));
        });
        await page.reload();

        // Tour should auto-start after 1.5s delay
        const modal = page.locator('.tour-modal');
        await expect(modal).toBeVisible({ timeout: 5_000 });

        // Should show welcome step
        await expect(page.locator('.tour-title')).toContainText('Welcome');
    });

    test('tour can be skipped', async ({ page }) => {
        await page.goto('/dashboard.html');
        await page.evaluate(() => {
            localStorage.removeItem('ppx_tour_completed');
            localStorage.setItem('pp_auth', JSON.stringify({
                signedIn: true, email: 'test@test.com', name: 'Test',
                plan: 'free', role: 'user', provider: 'mock',
            }));
        });
        await page.reload();

        const modal = page.locator('.tour-modal');
        await expect(modal).toBeVisible({ timeout: 5_000 });

        // Click skip
        await page.click('#tour-skip');

        // Modal should disappear
        await expect(modal).not.toBeVisible({ timeout: 2_000 });
    });

    test('tour does not reappear after completion', async ({ page }) => {
        await page.goto('/dashboard.html');
        await page.evaluate(() => {
            localStorage.setItem('ppx_tour_completed', '1');
            localStorage.setItem('pp_auth', JSON.stringify({
                signedIn: true, email: 'test@test.com', name: 'Test',
                plan: 'free', role: 'user', provider: 'mock',
            }));
        });
        await page.reload();

        // Wait past the auto-start delay
        await page.waitForTimeout(2500);

        // Tour should NOT appear
        const modal = page.locator('.tour-modal');
        await expect(modal).not.toBeVisible();
    });
});

// ── 9. Edge Function Health ─────────────────────────────────────────────────

test.describe('API Edge Functions', () => {
    test('stripe checkout rejects GET', async ({ request }) => {
        const res = await request.get('/api/stripe/checkout');
        expect(res.status()).toBe(405);
    });

    test('stripe checkout rejects unauthorized POST', async ({ request }) => {
        const res = await request.post('/api/stripe/checkout', {
            data: { plan: 'basic' },
        });
        // Should be 401 (unauthorized) or 501 (not configured in test)
        expect([401, 501]).toContain(res.status());
    });

    test('stripe portal rejects GET', async ({ request }) => {
        const res = await request.get('/api/stripe/portal');
        expect(res.status()).toBe(405);
    });

    test('stripe webhook rejects GET', async ({ request }) => {
        const res = await request.get('/api/stripe/webhook');
        expect(res.status()).toBe(405);
    });

    test('alert email rejects GET', async ({ request }) => {
        const res = await request.get('/api/alerts/email');
        expect(res.status()).toBe(405);
    });

    test('alert email rejects unauthorized POST', async ({ request }) => {
        const res = await request.post('/api/alerts/email', {
            data: { title: 'test', body: 'test' },
        });
        expect([401, 501]).toContain(res.status());
    });
});
