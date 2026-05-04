/**
 * E2E tests: dashboard auth gate clears for every tier of user.
 *
 * Why this file exists: the user-visible bug is "I keep getting stuck on
 * the auth gate even after signing in". The redirect chain is
 *   signin.html  → dashboard.html (gate evaluation in module script)
 *   signup.html  → dashboard.html
 *   auth-callback.html (OAuth / magic link) → dashboard.html
 * If the gate evaluation in dashboard.html doesn't see the persisted
 * session for ANY plan/role the user can hold, the user lands back on
 * the gate and clicks Sign In again, producing an infinite loop.
 *
 * The dashboard auth gate's effective check is:
 *   auth.isSignedIn()  OR  JSON.parse(localStorage.pp_auth || sessionStorage.pp_auth).signedIn
 * so the contract these tests pin is: every tier we issue (every plan
 * AND every role) populates one of those two paths in a way that
 * clears the gate.
 *
 * We mock-authenticate by injecting `pp_auth` into localStorage —
 * Supabase isn't configured in CI, so auth.js falls through to its
 * mock-mode loader (`_loadMock`) which reads exactly that key. This
 * mirrors what the existing Onboarding-Tour suite does (see
 * auth-flows.spec.js, "Onboarding Tour" describe block) so the pattern
 * is consistent.
 *
 * Run:  npx playwright test tests/auth-tier-redirect.spec.js
 */

import { test, expect } from '@playwright/test';

// All seven plan IDs from js/tier-config.js TIERS, plus the three
// roles that bypass plan-based gating (admin/superadmin/tester role).
// Tester appears twice on purpose: once as a plan, once as a role.
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

function mockAuthFor(plan, role) {
    return {
        signedIn: true,
        email:    `${role}-${plan}@playwright.test`,
        name:     `Test ${role}`,
        plan,
        role,
        provider: 'mock',
        ts:       Date.now(),
    };
}

// ── 1. Dashboard auth gate clears for every tier ────────────────────────────
//
// This is the primary regression guard for the "stuck on auth gate"
// report: if any tier fixture fails to clear the gate, the user
// would experience an infinite signin → dashboard → signin loop.

test.describe('Dashboard auth gate — all tiers', () => {
    for (const fx of TIER_FIXTURES) {
        test(`clears gate for ${fx.label}`, async ({ page }) => {
            // Land on the dashboard once so we have a same-origin
            // localStorage to write into, then inject the session
            // before the module script runs on reload.
            await page.goto('/dashboard.html');
            await page.evaluate((auth) => {
                localStorage.setItem('pp_auth', JSON.stringify(auth));
                // Ensure no stale demo flag — demo mode uses a different
                // gate-clear path and would mask a real regression.
                sessionStorage.removeItem('pp_demo_mode');
            }, mockAuthFor(fx.plan, fx.role));

            await page.reload();

            // Gate should be hidden — auth.js falls through to mock
            // mode (no Supabase env in CI) and dashboard.html's
            // localStorage fallback at lines 1156–1163 reads pp_auth.
            const gate = page.locator('#auth-gate');
            // The `display: none` is set as inline style by the script,
            // so the locator should be hidden once the script has run.
            await expect(gate).toBeHidden({ timeout: 10_000 });

            // Main dashboard content should be visible (visibility flips
            // back from 'hidden' once the gate has cleared).
            const main = page.locator('main');
            await expect(main).toBeVisible();
        });
    }
});

// ── 2. Plan badge reflects the user's tier ──────────────────────────────────
//
// Catches the case where the gate clears but the plan badge stays on
// the default "Free" — that mismatch is what users see when the
// localStorage payload is read but tier-config / fetchProfile didn't
// run, and it's the most common "looks broken" symptom after a
// successful sign-in.

test.describe('Plan badge after sign-in', () => {
    const BADGE_FIXTURES = [
        { plan: 'free',        role: 'user',       text: /^Free Trial$/i,   cls: /plan-free/ },
        { plan: 'basic',       role: 'user',       text: /^Basic$/i,        cls: /plan-basic/ },
        { plan: 'educator',    role: 'user',       text: /^Educator$/i,     cls: /plan-educator/ },
        { plan: 'advanced',    role: 'user',       text: /^Advanced$/i,     cls: /plan-advanced/ },
        { plan: 'institution', role: 'user',       text: /^Institution$/i,  cls: /plan-institution/ },
        { plan: 'enterprise',  role: 'user',       text: /^Enterprise$/i,   cls: /plan-enterprise/ },
        // Role-overrides — admins/superadmins get the role label, not
        // the plan. tester plan keeps the plan label (it's a comp tier).
        { plan: 'free',        role: 'admin',      text: /^Admin$/i,        cls: /plan-advanced/ },
        { plan: 'enterprise',  role: 'superadmin', text: /^Superadmin$/i,   cls: /plan-advanced/ },
    ];

    for (const fx of BADGE_FIXTURES) {
        test(`shows correct badge for plan=${fx.plan} role=${fx.role}`, async ({ page }) => {
            await page.goto('/dashboard.html');
            await page.evaluate((auth) => {
                localStorage.setItem('pp_auth', JSON.stringify(auth));
                sessionStorage.removeItem('pp_demo_mode');
                // Suppress the welcome-tour modal — it overlays the badge
                // and isn't what this test cares about.
                localStorage.setItem('ppx_tour_completed', '1');
            }, mockAuthFor(fx.plan, fx.role));
            await page.reload();

            const badge = page.locator('#plan-badge');
            await expect(badge).toBeVisible({ timeout: 10_000 });
            await expect(badge).toHaveText(fx.text);
            await expect(badge).toHaveClass(fx.cls);
        });
    }
});

// ── 3. Signin page bounces signed-in users to dashboard ─────────────────────
//
// Pins the OTHER half of the redirect contract: a user who already
// has a valid session and lands on /signin.html should be redirected
// to the dashboard, NOT see the signin form. The opposite failure
// (signin form visible to a signed-in user) is what produces the
// "redirect loop" symptom when combined with a flaky gate evaluation.

test.describe('Signin page — already signed in', () => {
    for (const fx of TIER_FIXTURES) {
        test(`bounces ${fx.label} to dashboard`, async ({ page }) => {
            await page.goto('/signin.html');
            await page.evaluate((auth) => {
                localStorage.setItem('pp_auth', JSON.stringify(auth));
            }, mockAuthFor(fx.plan, fx.role));

            // Wait for the auth.ready() → location.href = 'dashboard.html'
            // bounce. The signin.html module script does this synchronously
            // after auth.ready() resolves.
            await page.goto('/signin.html');
            await page.waitForURL(/dashboard\.html/, { timeout: 10_000 });
            expect(page.url()).toMatch(/dashboard\.html/);
        });
    }
});

// ── 4. Sign-out path clears the session ─────────────────────────────────────
//
// The mirror of the gate-clear contract: after signOut the gate must
// re-appear. If signOut leaves a stale pp_auth row behind, the user
// "comes back signed in" on the next page load — confusing for shared
// computers, and a real privacy bug.

test.describe('Sign-out flow', () => {
    test('clears pp_auth from both storages', async ({ page }) => {
        await page.goto('/dashboard.html');
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

        // Drive auth.signOut() directly via the module — no UI
        // dependency on the nav's sign-out button (which lives in a
        // separate component and has its own tests).
        await page.evaluate(async () => {
            const { auth } = await import('/js/auth.js');
            await auth.ready();
            // Suppress the redirect — we want to inspect storage state
            // after signOut, not chase the navigation.
            await auth.signOut(null);
        });

        const localOk   = await page.evaluate(() => localStorage.getItem('pp_auth'));
        const sessionOk = await page.evaluate(() => sessionStorage.getItem('pp_auth'));
        expect(localOk).toBeNull();
        expect(sessionOk).toBeNull();
    });
});

// ── 5. Magic-link mode toggle doesn't throw ─────────────────────────────────
//
// Regression guard for the alert-banner null-reference bug in
// signin.html (id was 'alert-banner' but the actual element is
// 'login-alert'). The bug surfaced as a thrown TypeError on the very
// first click of the magic-link toggle, which froze the form mid-
// transition and was a likely contributor to "stuck" signin sessions.

test.describe('Signin form — magic link toggle', () => {
    test('toggle does not throw when switching modes', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('/signin.html');
        // Wait for the form to render past the auth.ready() gate.
        await expect(page.locator('#magic-toggle')).toBeVisible();

        await page.click('#magic-toggle');
        await expect(page.locator('#pw-row')).toBeHidden();

        await page.click('#magic-toggle');
        await expect(page.locator('#pw-row')).toBeVisible();

        // Any TypeError during toggle would be a regression of the
        // alert-banner / login-alert mismatch we just fixed.
        expect(errors.join('\n')).not.toMatch(/Cannot read.*classList/);
        expect(errors.join('\n')).not.toMatch(/null/i);
    });
});
