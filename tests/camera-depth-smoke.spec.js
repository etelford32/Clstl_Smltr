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

    // Close fly-to → lands in the tilt band above the floor.
    await page.evaluate(() => window.flyToLatLon(40, -100, 1.10));
    await page.waitForFunction(() => !window.__evCamera().flying, null, { timeout: 20000 });
    await page.waitForTimeout(1200);   // post-arrival tilt ease

    const low = await cam(page);
    expect(low.dist).toBeGreaterThanOrEqual(1.025);   // never through the floor
    expect(low.dist).toBeLessThan(1.2);
    expect(low.band).toBe('low');
    expect(low.tilt).toBeGreaterThan(0.05);           // pivot off-centre
    expect(low.targetR).toBeGreaterThan(0.05);
    expect(low.near).toBeLessThan(0.05);              // near plane followed us down

    // Fly back out → tilt releases, pivot eases home to the globe centre.
    await page.evaluate(() => window.flyToLatLon(40, -100, 4.2));
    await page.waitForFunction(() => !window.__evCamera().flying, null, { timeout: 20000 });
    await page.waitForTimeout(2500);   // release ease

    const out = await cam(page);
    expect(out.band).toBe('orbit');
    expect(out.tilt).toBeLessThan(0.01);
    expect(out.targetR).toBeLessThan(0.05);
    expect(out.near).toBeCloseTo(0.05, 2);

    expect(pageErrors, pageErrors.join('\n')).toHaveLength(0);
});
