/**
 * spaceship-designer-smoke.spec.js — boot + physics smoke test
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies spaceship-designer.html loads without console errors, the design /
 * ascent engine self-tests pass (default rocket reaches orbit), and launching
 * advances the flight (HUD altitude climbs off zero). Mirrors the style of
 * satellite-designer-smoke.spec.js, leaning on the exposed `window.__ssd`.
 */

import { test, expect } from '@playwright/test';

const URL = '/spaceship-designer.html';
const BOOT_TIMEOUT_MS = 15_000;

function attachConsoleRecorder(page) {
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push({ text: msg.text(), location: msg.location() });
    });
    page.on('pageerror', (err) => errors.push({ text: err.message, stack: err.stack }));
    return errors;
}

test.describe('spaceship-designer.html smoke', () => {

    test('boots without console errors', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(URL);
        await page.waitForFunction(() => window.__ssd?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(1000);

        // Supabase CDN can be blocked in CI sandboxes — the page degrades to a
        // local-only hangar, which is expected behaviour, not a page fault.
        const filtered = errors.filter((e) =>
            !/supabase|jsdelivr|Failed to fetch|net::ERR/i.test(e.text || ''));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'No unexpected console errors during boot').toHaveLength(0);
    });

    test('design + ascent engine self-test passes', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => window.__ssd?.ready, { timeout: BOOT_TIMEOUT_MS });
        const result = await page.evaluate(() => window.__ssd.selfTest());
        if (!result.ok) console.error('Self-test checks:', result.checks);
        expect(result.ok, 'All design/ascent self-test checks pass').toBe(true);
    });

    test('launching advances the flight', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => window.__ssd?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.getByRole('button', { name: /Launch/i }).click();
        // Altitude HUD should climb off zero within a few seconds of the ascent.
        await page.waitForFunction(() => {
            const t = document.getElementById('hud-alt')?.textContent || '0';
            return parseFloat(t) > 1;
        }, { timeout: 12_000 });
        const alt = await page.evaluate(() => document.getElementById('hud-alt')?.textContent);
        expect(parseFloat(alt)).toBeGreaterThan(1);
    });
});
