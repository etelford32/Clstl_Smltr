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

    test('builder self-test passes', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => !!window.__sd, { timeout: BOOT_TIMEOUT_MS });
        const results = await page.evaluate(() => window.__sd.builder.selfTest());
        const failures = results.filter(r => !r.pass);
        expect(failures,
            `builder self-tests pass (failures: ${failures.map(f => f.msg).join('; ')})`
        ).toHaveLength(0);
    });

    test('design bay opens, configures parts and applies to the ship', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => !!window.__sd, { timeout: BOOT_TIMEOUT_MS });

        await page.click('#b-bay');
        await page.waitForSelector('#bay.show', { timeout: 4000 });
        // Part chips render even when the 3-D CDN is blocked (graceful degrade).
        await page.waitForFunction(
            () => document.querySelectorAll('#bay-body .opt').length >= 3, { timeout: 4000 });

        const specHasNumber = await page.evaluate(() =>
            /\d/.test(document.querySelector('#bs-mass').textContent));
        expect(specHasNumber, 'bay spec readout populated').toBe(true);

        // Pick the big bus + remove panels, then apply — dry mass must jump and
        // Cd must collapse to the bare-bus value.
        await page.click('#bay-body .opt[data-v="bus_med"]');
        await page.click('#bay-panel .opt[data-v="none"]');
        await page.click('#bay-apply');
        await page.waitForSelector('#bay:not(.show)', { timeout: 4000 });

        const form = await page.evaluate(() => ({
            dry: Number(document.querySelector('#f-dry').value),
            cd: Number(document.querySelector('#f-cd').value),
            build: window.__sd.bay.getBuild(),
        }));
        expect(form.dry, 'medium bus is heavy').toBeGreaterThan(300);
        expect(form.cd, 'no panels ⇒ bare-bus Cd').toBeCloseTo(2.2, 1);
        expect(form.build.body).toBe('bus_med');
    });

    test('build config round-trips through the design draft', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => !!window.__sd, { timeout: BOOT_TIMEOUT_MS });

        const data = await page.evaluate(() => window.__sd.ui.currentDesignData());
        expect(data.build, 'design data carries the 3-D build').toBeTruthy();
        expect(data.build.body, 'build has a chassis').toBeTruthy();
        expect(data.build.thruster, 'build has a thruster type').toBeTruthy();
    });
});
