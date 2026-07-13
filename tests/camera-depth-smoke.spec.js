import { test, expect } from '@playwright/test';

/**
 * camera-depth-smoke.spec.js — Phase-3 camera depth pipeline.
 *
 * Exercises the window.__evCamera probe: dynamic near plane, the 1.025
 * dolly floor, horizon-tilt pivot engagement on a close fly-to, and full
 * reversibility (pivot eases home) on a continental fly-out. Runs without
 * live network.
 */

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost'],
    },
    ignoreHTTPSErrors: true,
});

async function cam(page) {
    return page.evaluate(() => window.__evCamera());
}

test('camera floor, dynamic near, horizon tilt engage and release', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/earth.html', { waitUntil: 'load' });
    await page.waitForFunction(() =>
        typeof window.__evCamera === 'function' && typeof window.flyToLatLon === 'function');
    await page.waitForTimeout(2500);   // let animate settle a few frames

    // Boot state: orbital distance, near plane resting at its cap, no tilt.
    const boot = await cam(page);
    expect(boot.dist).toBeGreaterThan(2.5);
    expect(boot.near).toBeCloseTo(0.05, 2);
    expect(boot.band).toBe('orbit');
    expect(boot.tilt).toBeLessThan(0.01);

    // Close fly-to → lands in the tilt band above the floor. Poll for the
    // settled state rather than sleeping fixed intervals — under software
    // GL the ease durations scale with whatever else the CPU is doing.
    await page.evaluate(() => window.flyToLatLon(40, -100, 1.10));
    await page.waitForFunction(() => {
        const c = window.__evCamera();
        return !c.flying && c.band === 'low' && c.tilt > 0.05 && c.targetR > 0.05;
    }, null, { timeout: 45000 });

    const low = await cam(page);
    expect(low.dist).toBeGreaterThanOrEqual(1.025);   // never through the floor
    expect(low.dist).toBeLessThan(1.2);
    expect(low.near).toBeLessThan(0.05);              // near plane followed us down

    // Fly back out → tilt releases, pivot eases home to the globe centre.
    await page.evaluate(() => window.flyToLatLon(40, -100, 4.2));
    await page.waitForFunction(() => {
        const c = window.__evCamera();
        return !c.flying && c.band === 'orbit' && c.tilt < 0.01 && c.targetR < 0.05;
    }, null, { timeout: 45000 });

    const out = await cam(page);
    expect(out.near).toBeCloseTo(0.05, 2);

    expect(pageErrors, pageErrors.join('\n')).toHaveLength(0);
});
