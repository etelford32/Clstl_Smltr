// space-weather-d3.spec.js — browser gate for the D3 trust + briefing
// layer on space-weather.html: the validation scorecard (wearing the
// test-pinned hindcast numbers AND the documented Dst-ceiling miss), the
// personal storm log (a rising-edge crossing of YOUR Kp line records an
// entry), and the print-briefing affordance.

import { test, expect } from '@playwright/test';

test.describe('D3 trust + briefing', () => {

    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('pp_auth', JSON.stringify({
                signedIn: true, id: 'e2e-d3', email: 'e2e@playwright.test',
                plan: 'free', role: 'user', provider: 'password',
            }));
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch {}
        });
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });
    });

    test('scorecard wears the pinned numbers AND the miss', async ({ page }) => {
        const card = page.locator('[data-lab-panel="scorecard"]');
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(card).toContainText('0.686');            // St. Patrick's r
        await expect(card).toContainText('0.663');            // Gannon r
        await expect(card).toContainText('−280');             // the ceiling…
        await expect(card).toContainText('−412');             // …vs published
        await expect(card).toContainText('documented miss');
        await expect(card.locator('a[href="gannon-superstorm.html"]')).toBeVisible();
    });

    test('storm log records a rising-edge crossing of YOUR line', async ({ page }) => {
        const body = page.locator('#storm-log-body');
        await expect(body).toContainText('No crossings', { timeout: 30_000 });
        // Quiesce, then push Kp through the bus: below → above the default
        // Kp 5 line = one rising edge.
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
        await page.evaluate(() => {
            let hi = setTimeout(() => {}, 0);
            for (let i = 1; i <= hi; i++) { clearTimeout(i); clearInterval(i); }
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: { kp: 3 } }));
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: { kp: 6.3 } }));
        });
        await expect(body).toContainText('Kp 6.3 crossed your Kp 5 line', { timeout: 15_000 });
        const stored = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('sw-storm-log')));
        expect(stored.entries.length).toBe(1);
        expect(stored.entries[0].kp).toBe(6.3);
    });

    test('print briefing affordance exists with a print stylesheet behind it', async ({ page }) => {
        await expect(page.locator('#sw-print-btn')).toBeVisible({ timeout: 30_000 });
        // The @media print block is in the page (emulateMedia proves the
        // canvas-heavy panels drop out of the briefing).
        await page.emulateMedia({ media: 'print' });
        await expect(page.locator('.stage-section')).toBeHidden();
        await expect(page.locator('.helio-hero-wrap')).toBeHidden();
        await expect(page.locator('#sw-status-band')).toBeVisible();
        await page.emulateMedia({ media: 'screen' });
    });
});
