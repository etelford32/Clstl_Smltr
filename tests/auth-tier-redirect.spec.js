/**
 * E2E tests: canonical sign-in / sign-up / dashboard contract.
 *
 * Replaces the older "every successful signin lands on dashboard" assertion
 * with the new contract:
 *
 *   1. Anonymous visitor to /dashboard.html → bounced to /signin?next=/dashboard.html
 *      (requireAuth() preserves the deep link in BOTH ?next= and
 *      sessionStorage.pp_auth_redirect; either path returns the user
 *      after sign-in).
 *
 *   2. Already-signed-in visitor to /signin.html → renders the "You're
 *      already signed in" panel inline. No auto-redirect. Continue
 *      button targets pickPostSigninDest() (next > pp_auth_redirect > dashboard);
 *      Sign-out button clears the session and reloads.
 *
 *   3. Already-signed-in visitor to /signup.html → renders the "You
 *      already have an account" panel. Same no-auto-bounce contract.
 *
 *   4. /welcome.html renders for signed-in users and gates anonymous
 *      visitors via requireAuth() → /signin?next=%2Fwelcome.html.
 *
 *   5. /settings.html renders the three migrated cards (subscription,
 *      alert prefs, saved locations) and applies tier gates correctly.
 *
 *   6. Dashboard tier-aware skeleton: free users do NOT see Personal
 *      Report / Impact Score / Trip Planning / Alert History / Class
 *      Roster; basic+ users see the basic set; educator/advanced+ users
 *      see all of them. Verified via the data-tier-visible attribute
 *      written by applyTierLayout().
 *
 *   7. ?next= allowlist on /signin rejects off-origin and
 *      protocol-relative values, honours same-origin paths.
 *
 *   8. Sign-out still clears pp_auth from both storages (regression
 *      guard for the existing test).
 *
 * Auth is mocked via localStorage 'pp_auth' (auth.js falls through to
 * its mock loader when Supabase isn't configured in CI).
 *
 * Run: npx playwright test tests/auth-tier-redirect.spec.js
 */

import { test, expect } from '@playwright/test';

const TIER_FIXTURES = [
    { label: 'free / user',                 plan: 'free',        role: 'user' },
    { label: 'tester (comp plan)',          plan: 'tester',      role: 'user' },
    { label: 'tester (comp role)',          plan: 'free',        role: 'tester' },
    { label: 'basic',                       plan: 'basic',       role: 'user' },
    { label: 'educator',                    plan: 'educator',    role: 'user' },
    { label: 'advanced',                    plan: 'advanced',    role: 'user' },
    { label: 'institution',                 plan: 'institution', role: 'user' },
    { label: 'enterprise',                  plan: 'enterprise',  role: 'user' },
    { label: 'admin',                       plan: 'free',        role: 'admin' },
    { label: 'superadmin',                  plan: 'enterprise',  role: 'superadmin' },
];

function mockAuthFor(plan, role, extra = {}) {
    return {
        signedIn: true,
        email:    `${role}-${plan}@playwright.test`,
        name:     `Test ${role}`,
        plan,
        role,
        provider: 'mock',
        ts:       Date.now(),
        ...extra,
    };
}

/**
 * Seed a mock session into localStorage.
 *
 * Why we visit `/` first: every protected page now calls
 * `auth.requireAuth()` as its first module-script line, which navigates
 * the page away when no session is present. If the test called
 * `page.evaluate(...)` directly without a same-origin landing pad, the
 * write could race the redirect. Visiting the unprotected home page
 * once gives us a stable localStorage context that all subsequent
 * `page.goto(<protected-page>)` calls inherit.
 */
async function setAuth(page, plan, role, extra = {}) {
    await page.goto('/');
    await page.evaluate((auth) => {
        localStorage.setItem('pp_auth', JSON.stringify(auth));
        sessionStorage.removeItem('pp_demo_mode');
    }, mockAuthFor(plan, role, extra));
}

// ─────────────────────────────────────────────────────────────────────
// 1. Dashboard auth gate clears for every tier
// ─────────────────────────────────────────────────────────────────────

test.describe('Dashboard auth gate — all tiers', () => {
    for (const fx of TIER_FIXTURES) {
        test(`clears gate for ${fx.label}`, async ({ page }) => {
            await setAuth(page, fx.plan, fx.role);
            await page.goto('/dashboard.html');

            // Gate should be hidden; main should be visible.
            const gate = page.locator('#auth-gate');
            await expect(gate).toBeHidden({ timeout: 10_000 });
            await expect(page.locator('main')).toBeVisible();
        });
    }
});

// ─────────────────────────────────────────────────────────────────────
// 2. Anonymous dashboard visit → /signin?next=/dashboard.html
// ─────────────────────────────────────────────────────────────────────

test.describe('requireAuth deep-link preservation', () => {
    test('anonymous /dashboard.html redirects to /signin?next=/dashboard.html', async ({ page }) => {
        // Ensure no session.
        await page.goto('/');
        await page.evaluate(() => {
            localStorage.removeItem('pp_auth');
            sessionStorage.removeItem('pp_auth');
            sessionStorage.removeItem('pp_auth_redirect');
        });
        await page.goto('/dashboard.html');
        await page.waitForURL(/\/signin\.html\?next=/, { timeout: 10_000 });
        const url = new URL(page.url());
        expect(url.searchParams.get('next')).toContain('dashboard.html');

        // sessionStorage fallback should also be set.
        const stashed = await page.evaluate(() => sessionStorage.getItem('pp_auth_redirect'));
        expect(stashed).toContain('dashboard.html');
    });

    test('anonymous /settings.html redirects to /signin?next=%2Fsettings.html', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(() => {
            localStorage.removeItem('pp_auth');
            sessionStorage.removeItem('pp_auth');
        });
        await page.goto('/settings.html');
        await page.waitForURL(/\/signin/, { timeout: 10_000 });
        // The anchor-link version of settings sets next= via the
        // hardcoded link, but the requireAuth navigation also runs;
        // either way the post-signin destination must round-trip.
        const url = new URL(page.url());
        const next = url.searchParams.get('next');
        expect(next).toMatch(/settings\.html/);
    });

    test('anonymous /welcome.html redirects to /signin?next=%2Fwelcome.html', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(() => {
            localStorage.removeItem('pp_auth');
            sessionStorage.removeItem('pp_auth');
        });
        await page.goto('/welcome.html');
        await page.waitForURL(/\/signin/, { timeout: 10_000 });
        const url = new URL(page.url());
        const next = url.searchParams.get('next');
        expect(next).toMatch(/welcome\.html/);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Already-signed-in panel (signin + signup) — NO auto-bounce
// ─────────────────────────────────────────────────────────────────────

test.describe('Signin page — already signed in', () => {
    for (const fx of TIER_FIXTURES) {
        test(`shows panel (does not redirect) for ${fx.label}`, async ({ page }) => {
            await setAuth(page, fx.plan, fx.role);
            await page.goto('/signin.html');

            // No auto-redirect — we should stay on /signin.html.
            await expect(page.locator('#already-signed-in')).toBeVisible({ timeout: 10_000 });
            expect(page.url()).toMatch(/signin\.html/);
            await expect(page.locator('#signin-form')).toBeHidden();

            // Continue button defaults to dashboard.html when no ?next=
            // and no pp_auth_redirect is stashed.
            const href = await page.locator('#asi-continue').getAttribute('href');
            expect(href).toMatch(/dashboard\.html|^\//);
        });
    }

    test('continue button honours ?next= (same-origin path)', async ({ page }) => {
        await setAuth(page, 'free', 'user');
        await page.goto('/signin.html?next=%2Fsettings.html%23alert-prefs');
        await expect(page.locator('#already-signed-in')).toBeVisible({ timeout: 10_000 });
        const href = await page.locator('#asi-continue').getAttribute('href');
        expect(href).toBe('/settings.html#alert-prefs');
    });

    test('continue button REJECTS off-origin ?next= and falls back to dashboard', async ({ page }) => {
        await setAuth(page, 'free', 'user');
        await page.goto('/signin.html?next=https%3A%2F%2Fevil.example%2F');
        await expect(page.locator('#already-signed-in')).toBeVisible({ timeout: 10_000 });
        const href = await page.locator('#asi-continue').getAttribute('href');
        expect(href).not.toMatch(/evil\.example/);
        expect(href).toMatch(/dashboard\.html$/);
    });

    test('continue button REJECTS protocol-relative ?next=', async ({ page }) => {
        await setAuth(page, 'free', 'user');
        await page.goto('/signin.html?next=%2F%2Fevil.example%2Fxx');
        await expect(page.locator('#already-signed-in')).toBeVisible({ timeout: 10_000 });
        const href = await page.locator('#asi-continue').getAttribute('href');
        expect(href).not.toMatch(/evil\.example/);
        expect(href).toMatch(/dashboard\.html$/);
    });

    test('sign-out button clears session and reloads', async ({ page }) => {
        await setAuth(page, 'free', 'user');
        await page.goto('/signin.html');
        await expect(page.locator('#already-signed-in')).toBeVisible({ timeout: 10_000 });
        await page.click('#asi-signout');
        // After signOut + reload, the form should be back and pp_auth gone.
        await expect(page.locator('#signin-form')).toBeVisible({ timeout: 10_000 });
        const auth = await page.evaluate(() => localStorage.getItem('pp_auth'));
        expect(auth).toBeNull();
    });
});

test.describe('Signup page — already signed in', () => {
    test('renders panel and does NOT auto-redirect', async ({ page }) => {
        await setAuth(page, 'free', 'user');
        await page.goto('/signup.html');
        await expect(page.locator('#already-signed-in')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#form-view')).toBeHidden();
        expect(page.url()).toMatch(/signup\.html/);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 4. /welcome.html renders for signed-in users; choice cards are wired
// ─────────────────────────────────────────────────────────────────────

test.describe('Welcome page', () => {
    test('renders for signed-in user with plan-aware greeting', async ({ page }) => {
        await setAuth(page, 'free', 'user');
        await page.goto('/welcome.html');
        await expect(page.locator('#auth-gate')).toBeHidden({ timeout: 10_000 });
        await expect(page.locator('#welcome-h1')).toBeVisible();
        await expect(page.locator('#choice-sim')).toBeVisible();
        await expect(page.locator('#choice-loc')).toBeVisible();
        await expect(page.locator('#choice-dash')).toBeVisible();
        // Free upgrade pill should be visible.
        await expect(page.locator('#upgrade-pill')).toBeVisible();
    });

    test('hides upgrade pill for paid tiers', async ({ page }) => {
        await setAuth(page, 'advanced', 'user');
        await page.goto('/welcome.html');
        await expect(page.locator('#choice-sim')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#upgrade-pill')).toBeHidden();
    });

    test('clicking "set location" reveals the inline form', async ({ page }) => {
        await setAuth(page, 'free', 'user');
        await page.goto('/welcome.html');
        await expect(page.locator('#choice-loc')).toBeVisible({ timeout: 10_000 });
        await page.click('#choice-loc');
        await expect(page.locator('#location-form')).toHaveClass(/open/);
        await expect(page.locator('#welcome-loc-input')).toBeVisible();
    });
});

// ─────────────────────────────────────────────────────────────────────
// 5. /settings.html — three cards render with correct tier gating
// ─────────────────────────────────────────────────────────────────────

test.describe('Settings page', () => {
    test('renders all three sections for signed-in user', async ({ page }) => {
        await setAuth(page, 'basic', 'user');
        await page.goto('/settings.html');
        await expect(page.locator('#auth-gate')).toBeHidden({ timeout: 10_000 });
        await expect(page.locator('#subscription')).toBeVisible();
        await expect(page.locator('#alert-prefs')).toBeVisible();
        await expect(page.locator('#saved-locations')).toBeVisible();
    });

    test('free users see alert-prefs gate', async ({ page }) => {
        await setAuth(page, 'free', 'user');
        await page.goto('/settings.html');
        await expect(page.locator('#alert-prefs')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#alert-prefs-gate')).toBeVisible();
        await expect(page.locator('#alert-prefs-content')).toBeHidden();
    });

    test('free users see saved-locations gate', async ({ page }) => {
        await setAuth(page, 'free', 'user');
        await page.goto('/settings.html');
        await expect(page.locator('#saved-locations')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#sl-gate')).toBeVisible();
        await expect(page.locator('#sl-content')).toBeHidden();
    });

    test('basic users see alert-prefs CONTENT (gate hidden)', async ({ page }) => {
        await setAuth(page, 'basic', 'user');
        await page.goto('/settings.html');
        await expect(page.locator('#alert-prefs-content')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#alert-prefs-gate')).toBeHidden();
    });

    test('advanced users get advanced-alert rows enabled (not disabled)', async ({ page }) => {
        await setAuth(page, 'advanced', 'user');
        await page.goto('/settings.html');
        await expect(page.locator('#alert-prefs-content')).toBeVisible({ timeout: 10_000 });
        const disabled = await page.locator('#pref-notify_radio_blackout').isDisabled();
        expect(disabled).toBeFalsy();
    });

    test('basic users have advanced-alert rows disabled', async ({ page }) => {
        await setAuth(page, 'basic', 'user');
        await page.goto('/settings.html');
        await expect(page.locator('#alert-prefs-content')).toBeVisible({ timeout: 10_000 });
        const disabled = await page.locator('#pref-notify_radio_blackout').isDisabled();
        expect(disabled).toBeTruthy();
    });
});

// ─────────────────────────────────────────────────────────────────────
// 6. Tier-aware dashboard skeleton
// ─────────────────────────────────────────────────────────────────────

test.describe('Dashboard tier-aware skeleton', () => {
    test('free user: paid-only cards hidden', async ({ page }) => {
        await setAuth(page, 'free', 'user');
        await page.goto('/dashboard.html');
        await expect(page.locator('#auth-gate')).toBeHidden({ timeout: 10_000 });
        // Wait for applyTierLayout() to stamp data-tier-visible on each card.
        await page.waitForFunction(() => {
            const ids = ['alert-card', 'impact-card', 'trip-planning-card', 'alert-history-card', 'class-roster-card'];
            return ids.every(id => document.getElementById(id)?.dataset.tierVisible !== undefined);
        }, null, { timeout: 10_000 });
        for (const id of ['alert-card', 'impact-card', 'trip-planning-card', 'alert-history-card', 'class-roster-card']) {
            const vis = await page.locator(`#${id}`).getAttribute('data-tier-visible');
            expect(vis, `${id} should be hidden for free user`).toBe('0');
        }
    });

    test('basic user: alert-card / impact-card / alert-history-card visible; trip / roster hidden', async ({ page }) => {
        await setAuth(page, 'basic', 'user');
        await page.goto('/dashboard.html');
        await page.waitForFunction(() => document.getElementById('alert-card')?.dataset.tierVisible !== undefined, null, { timeout: 10_000 });
        expect(await page.locator('#alert-card').getAttribute('data-tier-visible')).toBe('1');
        expect(await page.locator('#impact-card').getAttribute('data-tier-visible')).toBe('1');
        expect(await page.locator('#alert-history-card').getAttribute('data-tier-visible')).toBe('1');
        expect(await page.locator('#trip-planning-card').getAttribute('data-tier-visible')).toBe('0');
        expect(await page.locator('#class-roster-card').getAttribute('data-tier-visible')).toBe('0');
    });

    test('educator user: trip-planning + class-roster visible', async ({ page }) => {
        await setAuth(page, 'educator', 'user');
        await page.goto('/dashboard.html');
        await page.waitForFunction(() => document.getElementById('trip-planning-card')?.dataset.tierVisible !== undefined, null, { timeout: 10_000 });
        expect(await page.locator('#trip-planning-card').getAttribute('data-tier-visible')).toBe('1');
        expect(await page.locator('#class-roster-card').getAttribute('data-tier-visible')).toBe('1');
    });

    test('advanced user: trip-planning visible, class-roster hidden', async ({ page }) => {
        await setAuth(page, 'advanced', 'user');
        await page.goto('/dashboard.html');
        await page.waitForFunction(() => document.getElementById('trip-planning-card')?.dataset.tierVisible !== undefined, null, { timeout: 10_000 });
        expect(await page.locator('#trip-planning-card').getAttribute('data-tier-visible')).toBe('1');
        expect(await page.locator('#class-roster-card').getAttribute('data-tier-visible')).toBe('0');
    });

    test('admin role unlocks every card regardless of plan', async ({ page }) => {
        await setAuth(page, 'free', 'admin');
        await page.goto('/dashboard.html');
        await page.waitForFunction(() => document.getElementById('alert-card')?.dataset.tierVisible !== undefined, null, { timeout: 10_000 });
        for (const id of ['alert-card', 'impact-card', 'trip-planning-card', 'alert-history-card', 'class-roster-card']) {
            expect(await page.locator(`#${id}`).getAttribute('data-tier-visible')).toBe('1');
        }
    });
});

// ─────────────────────────────────────────────────────────────────────
// 7. Plan badge after sign-in (kept from old suite, still part of contract)
// ─────────────────────────────────────────────────────────────────────

test.describe('Plan badge after sign-in', () => {
    const BADGE_FIXTURES = [
        { plan: 'free',        role: 'user',       text: /^Free Trial$/i,   cls: /plan-free/ },
        { plan: 'basic',       role: 'user',       text: /^Basic$/i,        cls: /plan-basic/ },
        { plan: 'educator',    role: 'user',       text: /^Educator$/i,     cls: /plan-educator/ },
        { plan: 'advanced',    role: 'user',       text: /^Advanced$/i,     cls: /plan-advanced/ },
        { plan: 'institution', role: 'user',       text: /^Institution$/i,  cls: /plan-institution/ },
        { plan: 'enterprise',  role: 'user',       text: /^Enterprise$/i,   cls: /plan-enterprise/ },
        { plan: 'free',        role: 'admin',      text: /^Admin$/i,        cls: /plan-/ },
        { plan: 'enterprise',  role: 'superadmin', text: /^Superadmin$/i,   cls: /plan-/ },
    ];

    for (const fx of BADGE_FIXTURES) {
        test(`shows correct badge for plan=${fx.plan} role=${fx.role}`, async ({ page }) => {
            await setAuth(page, fx.plan, fx.role);
            await page.evaluate(() => localStorage.setItem('ppx_tour_completed', '1'));
            await page.goto('/dashboard.html');
            const badge = page.locator('#plan-badge');
            await expect(badge).toBeVisible({ timeout: 10_000 });
            await expect(badge).toHaveText(fx.text);
            await expect(badge).toHaveClass(fx.cls);
        });
    }
});

// ─────────────────────────────────────────────────────────────────────
// 8. Sign-out clears storage (regression guard)
// ─────────────────────────────────────────────────────────────────────

test.describe('Sign-out flow', () => {
    test('clears pp_auth from both storages', async ({ page }) => {
        // Use an unprotected page as the storage host — dashboard now
        // bounces anonymous visitors to /signin, which would race the
        // evaluate that writes pp_auth.
        await page.goto('/');
        await page.evaluate(() => {
            localStorage.setItem('pp_auth', JSON.stringify({
                signedIn: true, email: 'admin@test.com', name: 'Admin',
                plan: 'advanced', role: 'admin', provider: 'mock', ts: Date.now(),
            }));
            sessionStorage.setItem('pp_auth', JSON.stringify({
                signedIn: true, email: 'admin@test.com', name: 'Admin',
                plan: 'advanced', role: 'admin', provider: 'mock', ts: Date.now(),
            }));
        });
        await page.evaluate(async () => {
            const { auth } = await import('/js/auth.js');
            await auth.ready();
            await auth.signOut(null);
        });
        const localOk   = await page.evaluate(() => localStorage.getItem('pp_auth'));
        const sessionOk = await page.evaluate(() => sessionStorage.getItem('pp_auth'));
        expect(localOk).toBeNull();
        expect(sessionOk).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────
// 9. Magic-link toggle (regression for the alert-banner null bug)
// ─────────────────────────────────────────────────────────────────────

test.describe('Signin form — magic link toggle', () => {
    test('toggle does not throw when switching modes', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('/signin.html');
        // Make sure we're in the form view (no signed-in user).
        await page.evaluate(() => localStorage.removeItem('pp_auth'));
        await page.reload();
        await expect(page.locator('#magic-toggle')).toBeVisible({ timeout: 10_000 });

        await page.click('#magic-toggle');
        await expect(page.locator('#pw-row')).toBeHidden();
        await page.click('#magic-toggle');
        await expect(page.locator('#pw-row')).toBeVisible();

        expect(errors.join('\n')).not.toMatch(/Cannot read.*classList/);
        expect(errors.join('\n')).not.toMatch(/null/i);
    });
});
