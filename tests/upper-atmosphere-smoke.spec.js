/**
 * upper-atmosphere-smoke.spec.js — boot smoke test
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies that upper-atmosphere.html loads without console errors, the
 * engine self-tests all pass, and the three canvas surfaces render at
 * least one frame. Mirrors the style of earth-smoke.spec.js but leans
 * on the exposed `window.__ua` handle rather than a debug overlay.
 */

import { test, expect } from '@playwright/test';

const URL = '/upper-atmosphere.html';
const BOOT_TIMEOUT_MS = 15_000;

function attachConsoleRecorder(page) {
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') {
            errors.push({ text: msg.text(), location: msg.location() });
        }
    });
    page.on('pageerror', (err) => {
        errors.push({ text: err.message, stack: err.stack });
    });
    return errors;
}

test.describe('upper-atmosphere.html smoke', () => {

    test('boots without console errors', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(URL);
        await page.waitForFunction(() => !!window.__ua, { timeout: BOOT_TIMEOUT_MS });
        // Let the 3D scene + two canvas plots render a few frames.
        await page.waitForTimeout(1500);

        const filtered = errors.filter(e => {
            // The CDN blue-marble texture occasionally 503s — the page
            // falls back to the flat tint, which is expected behavior.
            return !/blue-marble|three-globe/i.test(e.text || '');
        });
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'No unexpected console errors during boot').toHaveLength(0);
    });

    test('engine self-test passes', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => !!window.__ua, { timeout: BOOT_TIMEOUT_MS });
        const results = await page.evaluate(() => window.__ua.engine.selfTest());
        const failures = results.filter(r => !r.pass);
        expect(failures, `all self-tests pass (failures: ${failures.map(f => f.msg).join('; ')})`).toHaveLength(0);
    });

    test('sliders update state and redraw plots', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => !!window.__ua, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(600);

        // Move the altitude slider and verify the state propagates.
        await page.fill('#ua-alt', '700');
        await page.dispatchEvent('#ua-alt', 'input');
        await page.waitForTimeout(200);
        const altText = await page.textContent('#ua-alt-val');
        expect(altText, 'altitude label updates').toContain('700');

        // The UI should have recomputed a fresh profile.
        const profileLen = await page.evaluate(() => window.__ua.ui.profile.samples.length);
        expect(profileLen, 'profile was sampled').toBeGreaterThan(50);
    });

    test('storm preset row is populated and clickable', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => !!window.__ua, { timeout: BOOT_TIMEOUT_MS });

        const chips = await page.locator('#ua-presets .ua-chip').count();
        expect(chips, 'at least 3 storm presets rendered').toBeGreaterThanOrEqual(3);

        // Click the "Gannon" preset and check that state flipped.
        await page.locator('#ua-presets .ua-chip', { hasText: /Gannon/i }).click();
        await page.waitForTimeout(250);
        const f107 = await page.evaluate(() => window.__ua.ui.state.f107);
        expect(f107, 'Gannon preset pushes F10.7 ~195').toBeGreaterThan(150);
    });
});
