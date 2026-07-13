import { test, expect } from '@playwright/test';

/**
 * analytics-probe-smoke.spec.js — Phase-4 analytics surfaces.
 *
 * Runs without live network (feeds fail gracefully). Asserts:
 *   1. The vorticity + verification + probe layer rows exist; toggling
 *      vorticity (incl. level changes) and verification throws nothing and
 *      follows the dead-chrome legend rule.
 *   2. Arming the probe and dispatching a synthetic pointer tap on the
 *      globe pins the probe panel with a populated body (dashes are fine —
 *      the sandbox has no data — but the structure must render).
 *   3. A synthetic weather-validation-residual event lights the residual
 *      pip + provenance row.
 *   4. Zero page errors throughout.
 */

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost'],
    },
    ignoreHTTPSErrors: true,
});

test('vorticity, verification, and column probe wire up without errors', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message + '\n' + (err.stack ?? '')));

    await page.goto('/earth.html', { waitUntil: 'load' });
    await page.waitForTimeout(4000);

    // 1. Rows exist.
    for (const id of ['lyr-vorticity', 'vort-level', 'lyr-verify', 'lyr-probe']) {
        await expect(page.locator(`#${id}`)).toHaveCount(1);
    }

    // Vorticity on + level walk — legend follows, nothing throws.
    await page.evaluate(() => {
        const el = document.getElementById('lyr-vorticity');
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#wx-vorticity-legend-box')).toBeVisible();
    for (const lvl of ['850', '500', '250', 'sfc']) {
        await page.evaluate((v) => {
            const sel = document.getElementById('vort-level');
            sel.value = v;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }, lvl);
        await page.waitForTimeout(150);
    }
    await page.evaluate(() => {
        const el = document.getElementById('lyr-vorticity');
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#wx-vorticity-legend-box')).toBeHidden();

    // Verification toggle + synthetic residual event → pip + provenance row.
    await page.evaluate(() => {
        const el = document.getElementById('lyr-verify');
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const N = 72 * 36;
        const mk = (v) => { const a = new Float32Array(N); a.fill(v); return a; };
        document.dispatchEvent(new CustomEvent('weather-validation-residual', {
            detail: {
                model_id: 'wind-advection-rk2-v1', horizon_h: 1,
                issued_ms: Date.now() - 3_600_000,
                target_ms: Date.now(), verified_ms: Date.now(),
                gridW: 72, gridH: 36,
                forecastPrecip: mk(2), truthPrecip: mk(1), persistencePrecip: mk(0.2),
            },
        }));
    });
    await page.waitForTimeout(300);
    await expect(page.locator('#wx-residual-legend-box')).toBeVisible();
    const provText = await page.textContent('#wx-prov-levels');
    expect(provText).toContain('Verified');
    expect(provText).toContain('beat pers.');

    // 2. Probe: arm + synthetic tap through the pointer pipeline.
    await page.evaluate(() => {
        const el = document.getElementById('lyr-probe');
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const canvas = page.locator('#c');
    const box = await canvas.boundingBox();
    // Real (trusted) mouse tap dead centre — the globe fills the middle of
    // the viewport, and a stationary click stays under the tap threshold.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    await expect(page.locator('#probe-panel')).toBeVisible();
    const probeText = await page.textContent('#probe-body');
    expect(probeText).toContain('Wind profile');
    expect(probeText).toContain('850 hPa');
    expect(probeText).toContain('Cloud-top hgt');

    // Close unpins.
    await page.evaluate(() => document.getElementById('probe-close').click());
    await expect(page.locator('#probe-panel')).toBeHidden();

    if (pageErrors.length) console.log('=== PAGE ERRORS ===\n' + pageErrors.join('\n---\n'));
    expect(pageErrors, pageErrors.join('\n---\n')).toHaveLength(0);
});
