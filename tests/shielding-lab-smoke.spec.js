/**
 * shielding-lab-smoke.spec.js — smoke test for the Shielding Lab page.
 * ═══════════════════════════════════════════════════════════════════════════
 * Boots shielding-lab.html in headless Chromium — no network mocking needed:
 * the page is fully self-contained (WASM kernel + canvases, all local) —
 * and verifies the page contract:
 *
 *   1. The WASM solver boots: CPCP readout becomes a plausible number
 *      (20–120 kV near the quiet steady state), R1/R2 populate.
 *   2. The dial canvas is painted (non-blank pixels).
 *   3. A scenario button arms its script and lights up.
 *   4. Clicking the dial opens the probe readout with real local values.
 *   5. The SAPS feedback toggle and layer toggles don't throw.
 *
 * Physics correctness is NOT tested here — that's rust-shielding's cargo
 * test suite plus tests/shielding-kernel-smoke.mjs (Node, committed wasm).
 *
 * Runs via `npx playwright test tests/shielding-lab-smoke.spec.js`.
 */

import { test, expect } from '@playwright/test';

test.describe('shielding lab', () => {
    let errors;

    // Telemetry lazy-loads the Supabase client from CDN; CI has no outbound
    // network and the page is designed to work without it — not a failure.
    const BENIGN = /supabase|cdn\.jsdelivr|Failed to load resource|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i;

    test.beforeEach(async ({ page }) => {
        errors = [];
        page.on('pageerror', (e) => { if (!BENIGN.test(String(e))) errors.push(String(e)); });
        page.on('console', (msg) => {
            if (msg.type() === 'error' && !BENIGN.test(msg.text())) errors.push(msg.text());
        });
        await page.goto('/shielding-lab.html');
    });

    test('solver boots and dial renders', async ({ page }) => {
        // CPCP populates once the kernel has stepped.
        await expect(page.locator('#sl-cpcp')).not.toHaveText('—', { timeout: 20_000 });
        const cpcp = parseFloat(await page.locator('#sl-cpcp').textContent());
        expect(cpcp).toBeGreaterThan(15);
        expect(cpcp).toBeLessThan(150);

        const r1 = parseFloat(await page.locator('#sl-r1').textContent());
        expect(r1).toBeGreaterThan(0.2);

        // Canvas actually painted: some non-transparent pixels off-center.
        const painted = await page.evaluate(() => {
            const c = document.getElementById('sl-dial');
            const ctx = c.getContext('2d');
            const d = ctx.getImageData(c.width * 0.3, c.height * 0.3, 40, 40).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
            return n;
        });
        expect(painted).toBeGreaterThan(100);

        expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
    });

    test('scenario buttons arm and sliders follow', async ({ page }) => {
        await expect(page.locator('#sl-cpcp')).not.toHaveText('—', { timeout: 20_000 });
        await page.click('#sl-scn-southward');
        await expect(page.locator('#sl-scn-southward')).toHaveClass(/active/);
        await expect(page.locator('#sl-scn-status')).toContainText('Southward');
        // Manual slider input cancels the scenario.
        await page.locator('#sl-bz').evaluate((el) => {
            el.value = '-10';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await expect(page.locator('#sl-scn-southward')).not.toHaveClass(/active/);
        expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
    });

    test('probe opens with local values; toggles are safe', async ({ page }) => {
        await expect(page.locator('#sl-cpcp')).not.toHaveText('—', { timeout: 20_000 });
        const dial = page.locator('#sl-dial');
        const box = await dial.boundingBox();
        // Click the auroral zone north of center (12 MLT, high lat).
        await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.28);
        await expect(page.locator('#sl-probe')).toHaveClass(/on/);
        await expect(page.locator('#sl-probe-pos')).toContainText('MLAT');
        await expect(page.locator('#sl-probe-sig')).toContainText('S');

        await page.click('#sl-layer-efield');
        await page.click('#sl-layer-drift');
        await page.click('#sl-saps-toggle');
        await page.click('#sl-pause');
        await expect(page.locator('#sl-pause')).toContainText('resume');
        await page.click('#sl-reset');
        await page.waitForTimeout(500);
        expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
    });
});
