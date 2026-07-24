/**
 * E2E: AurOracle (auroracle.html) access gate + 30-day outlook surface.
 *
 * Guards the contract that shipped broken once already:
 *   1. The teaser ↔ unlock gate follows tierLevel(plan, role) >= 2 — basic
 *      ("intro"), educator, advanced+, tester, admin unlock; free and
 *      signed-out stay on the frosted teaser.
 *   2. The 30-day chart always renders, and the provenance line under it
 *      (#au-outlook-status) always says whether the user is looking at the
 *      LIVE outlook or the illustrative sketch. (When NOAA retired the
 *      45-day URL in March 2026, the sketch silently stood in for real data
 *      for everyone — including paying intro users. Never silent again.)
 *   3. The header brand row carries the AurOracle logo.
 *
 * Auth is mocked via localStorage 'pp_auth': the Supabase CDN import is
 * aborted so js/auth.js deterministically falls through to its mock loader
 * in every environment (CI runners can otherwise reach jsdelivr).
 *
 * Run: npx playwright test tests/auroracle-gate.spec.js
 */

import { test, expect } from '@playwright/test';

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

async function setAuth(page, plan, role) {
    await page.goto('/');
    await page.evaluate((auth) => {
        if (auth) localStorage.setItem('pp_auth', JSON.stringify(auth));
        else localStorage.removeItem('pp_auth');
    }, plan ? mockAuthFor(plan, role) : null);
}

test.beforeEach(async ({ page }) => {
    // Force the deterministic mock-auth path regardless of network.
    await page.route('**://cdn.jsdelivr.net/**', route => route.abort());
});

// ─────────────────────────────────────────────────────────────────────
// 1. Access gate per tier
// ─────────────────────────────────────────────────────────────────────

test.describe('AurOracle access gate', () => {
    test('signed-out visitor stays on the frosted teaser', async ({ page }) => {
        await setAuth(page, null);
        await page.goto('/auroracle.html');
        await expect(page.locator('body')).toHaveClass(/au-locked/, { timeout: 15_000 });
        // Unlock overlay visible on the month card; content frosted.
        await expect(page.locator('.au-premium > .au-gate').first()).toBeVisible();
        await expect(page.locator('#au-access')).toContainText(/free preview/i);
    });

    test('free user stays locked (30-day premium)', async ({ page }) => {
        await setAuth(page, 'free', 'user');
        await page.goto('/auroracle.html');
        await expect(page.locator('body')).toHaveClass(/au-locked/, { timeout: 15_000 });
        await expect(page.locator('.au-premium > .au-gate').first()).toBeVisible();
    });

    // Three-tier ladder (HOME_GATING_PLAN.md Phase 2): a free ACCOUNT unlocks
    // the 7-night outlook (nights 4–7 un-frost via body.au-week) while the
    // 30-day premium stays gated behind Basic+.
    test('free account unlocks the 7-night but NOT the 30-day', async ({ page }) => {
        await setAuth(page, 'free', 'user');
        await page.goto('/auroracle.html');
        await expect(page.locator('body')).toHaveClass(/au-week/, { timeout: 15_000 });
        // Nights 4–7 un-frost for the free account.
        await expect.poll(() => page.evaluate(() => {
            const c = document.querySelector('.daycard.au-far');
            return c ? getComputedStyle(c).filter : 'missing';
        }), { timeout: 10_000 }).toBe('none');
        // …but the 30-day premium overlay is still up (Basic gate intact).
        await expect(page.locator('.au-premium > .au-gate').first()).toBeVisible();
        await expect(page.locator('#au-access')).toContainText(/7-night outlook unlocked/i);
    });

    test('basic ("intro") user unlocks the 30-day outlook', async ({ page }) => {
        await setAuth(page, 'basic', 'user');
        await page.goto('/auroracle.html');
        await expect(page.locator('body')).toHaveClass(/au-unlocked/, { timeout: 15_000 });
        await expect(page.locator('#au-access')).toContainText(/Intro access active/i);
        // No unlock overlay; month card content un-frosts (the filter has a
        // CSS transition, so poll rather than reading once).
        await expect(page.locator('.au-premium > .au-gate').first()).toBeHidden();
        await expect.poll(() => page.evaluate(() =>
            getComputedStyle(document.querySelector('.au-premium > .au-pinner')).filter,
        ), { timeout: 10_000 }).toBe('none');
        // Nights 4–7 un-frost too.
        await expect.poll(() => page.evaluate(() => {
            const c = document.querySelector('.daycard.au-far');
            return c ? getComputedStyle(c).filter : 'missing';
        }), { timeout: 10_000 }).toBe('none');
    });

    for (const fx of [
        { label: 'educator',           plan: 'educator',   role: 'user' },
        { label: 'advanced',           plan: 'advanced',   role: 'user' },
        { label: 'tester (comp plan)', plan: 'tester',     role: 'user' },
        { label: 'admin role',         plan: 'free',       role: 'admin' },
    ]) {
        test(`${fx.label} unlocks`, async ({ page }) => {
            await setAuth(page, fx.plan, fx.role);
            await page.goto('/auroracle.html');
            await expect(page.locator('body')).toHaveClass(/au-unlocked/, { timeout: 15_000 });
        });
    }
});

// ─────────────────────────────────────────────────────────────────────
// 2. 30-day chart + outlook provenance line
// ─────────────────────────────────────────────────────────────────────

test.describe('AurOracle 30-day outlook surface', () => {
    test('month chart renders and the provenance line reports a known state', async ({ page }) => {
        await setAuth(page, 'basic', 'user');
        await page.goto('/auroracle.html');
        await expect(page.locator('body')).toHaveClass(/au-unlocked/, { timeout: 15_000 });

        // Chart SVG populated by renderMonth().
        const children = await page.locator('#month-chart > *').count();
        expect(children).toBeGreaterThan(10);

        // Provenance line present, styled as one of the three states, non-empty.
        const status = page.locator('#au-outlook-status');
        await expect(status).toHaveClass(/live|degraded|sketch/, { timeout: 15_000 });
        await expect(status).not.toHaveText('');
    });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Header branding
// ─────────────────────────────────────────────────────────────────────

test.describe('AurOracle branding', () => {
    test('header brand row shows the AurOracle logo', async ({ page }) => {
        await page.goto('/auroracle.html');
        const logo = page.locator('.au-brand-logo');
        await expect(logo).toBeVisible();
        await expect(logo).toHaveAttribute('src', /Auroracle_logo/);
        // The asset actually loads (naturalWidth > 0 = decoded).
        const w = await logo.evaluate(img => img.naturalWidth);
        expect(w).toBeGreaterThan(0);
    });
});
