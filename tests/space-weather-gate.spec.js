// space-weather-gate.spec.js — browser gate for the sign-in gate on
// space-weather.html (SPACE_WEATHER_DASHBOARD_PLAN.md §3).
//
// Pins the three behaviors that matter:
//   1. anonymous visitors bounce to signin.html with the deep link intact
//      (?next=/space-weather.html — the round-trip readSafeNext honours),
//   2. a signed-in visitor (via the legacy pp_auth mirror, the same
//      belt-and-suspenders fallback dashboard.html trusts) gets the page
//      with the overlay removed,
//   3. ?preview=1 bypasses the gate entirely — the preview is the page's
//      public, non-interactive marketing embed and must keep working
//      without a session.
// The fourth path — an OAuth hash payload on this page forwarding to
// /auth-callback.html instead of being gated — is already pinned by
// tests/auth-e2e.spec.js ("an OAuth error landing on a normal page").

import { test, expect } from '@playwright/test';

const SEED_AUTH = () => {
    localStorage.setItem('pp_auth', JSON.stringify({
        signedIn: true, id: 'e2e-gate', email: 'e2e@playwright.test',
        plan: 'free', role: 'user', provider: 'password',
    }));
};

test.describe('space-weather sign-in gate', () => {

    test('anonymous visitor is redirected to signin with ?next= preserved', async ({ page }) => {
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });
        await page.waitForURL(/\/signin\.html\?/, { timeout: 15_000 });
        const next = new URL(page.url()).searchParams.get('next');
        expect(next, 'deep link survives the bounce').toBe('/space-weather.html');
    });

    test('signed-in visitor (pp_auth mirror) gets the page, overlay removed', async ({ page }) => {
        await page.addInitScript(SEED_AUTH);
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });
        // The gate module removes the overlay node outright for signed-in
        // visitors — not just hides it.
        await expect(page.locator('#sw-auth-gate')).toHaveCount(0, { timeout: 15_000 });
        expect(page.url()).toContain('/space-weather.html');
        await expect(page.locator('.sw-header .sw-title')).toHaveText('Space Weather');
    });

    test('?preview=1 bypasses the gate without a session', async ({ page }) => {
        await page.goto('/space-weather.html?preview=1', { waitUntil: 'domcontentloaded' });
        // preview-mode.js stamps <html data-preview> synchronously in <head>;
        // the gate defers to it and removes the overlay.
        await expect(page.locator('html')).toHaveAttribute('data-preview', '1');
        await expect(page.locator('#sw-auth-gate')).toHaveCount(0, { timeout: 15_000 });
        // And we must still be on the page, not bounced to signin.
        await page.waitForTimeout(1_000);
        expect(page.url()).toContain('/space-weather.html');
    });
});
