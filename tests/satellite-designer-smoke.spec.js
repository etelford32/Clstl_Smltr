/**
 * satellite-designer-smoke.spec.js — boot + physics smoke test
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies satellite-designer.html loads without console errors, the orbital
 * flight engine self-tests all pass, and launching a craft advances the
 * simulation (telemetry + orbit trail update). Mirrors the style of
 * upper-atmosphere-smoke.spec.js, leaning on the exposed `window.__sd`.
 */

import { test, expect } from '@playwright/test';

const URL = '/satellite-designer.html';
const BOOT_TIMEOUT_MS = 15_000;

function attachConsoleRecorder(page) {
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push({ text: msg.text(), location: msg.location() });
    });
    page.on('pageerror', (err) => errors.push({ text: err.message, stack: err.stack }));
    return errors;
}

test.describe('satellite-designer.html smoke', () => {

    test('boots without console errors', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(URL);
        await page.waitForFunction(() => !!window.__sd, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(1200);

        // Supabase CDN can be blocked in CI sandboxes — the page degrades to a
        // local-only hangar, which is expected behaviour, not a page fault.
        const filtered = errors.filter(e =>
            !/supabase|jsdelivr|Failed to fetch|net::ERR/i.test(e.text || ''));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'No unexpected console errors during boot').toHaveLength(0);
    });

    test('flight engine self-test passes', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => !!window.__sd, { timeout: BOOT_TIMEOUT_MS });
        const results = await page.evaluate(() => window.__sd.engine.selfTest());
        const failures = results.filter(r => !r.pass);
        expect(failures,
            `all self-tests pass (failures: ${failures.map(f => f.msg).join('; ')})`
        ).toHaveLength(0);
    });

    test('launch advances the simulation', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => !!window.__sd, { timeout: BOOT_TIMEOUT_MS });

        await page.click('#b-launch');
        // Crank time-warp so a couple of orbits pass within the test window.
        await page.click('#warp-modes .toggle[data-warp="600"]');
        await page.waitForTimeout(2500);

        const st = await page.evaluate(() => ({
            running: window.__sd.sim.running,
            t: window.__sd.sim.state?.t || 0,
            trail: window.__sd.sim.trail.length,
            alt: Number(document.querySelector('#m-alt .v').textContent.replace(/[^\d.]/g, '')),
        }));
        expect(st.t, 'mission clock advanced').toBeGreaterThan(60);
        expect(st.trail, 'orbit trail accumulated points').toBeGreaterThan(20);
        expect(st.alt, 'altitude telemetry is a sane LEO number').toBeGreaterThan(80);
    });

    test('design readouts compute Δv from the rocket equation', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => !!window.__sd, { timeout: BOOT_TIMEOUT_MS });

        await page.fill('#f-dry', '100');
        await page.fill('#f-fuel', '100');
        await page.fill('#f-isp', '300');
        await page.dispatchEvent('#f-isp', 'input');
        await page.waitForTimeout(150);

        // Δv = Isp·g0·ln(2) = 300 · 9.80665 · 0.6931 ≈ 2039 m/s
        const dv = await page.evaluate(() =>
            Number(document.querySelector('#d-dv').textContent.replace(/[^\d.]/g, '')));
        expect(dv).toBeGreaterThan(1950);
        expect(dv).toBeLessThan(2150);
    });
});
