/**
 * shielding-lab-smoke.spec.js — smoke test for the Shielding Lab page.
 * ═══════════════════════════════════════════════════════════════════════════
 * Boots shielding-lab.html in headless Chromium. The page is fully
 * self-contained (WASM kernel + canvases, all local); only the LIVE-mode
 * test mocks its SWPC routes so no test touches live network. Verifies:
 *
 *   1. The WASM solver boots: CPCP readout becomes a plausible number
 *      (20–120 kV near the quiet steady state), R1/R2 populate.
 *   2. The dial canvas is painted (non-blank pixels); the 3D globe view
 *      boots (or falls back cleanly) and the toggle round-trips.
 *   3. A scenario button arms its script and lights up.
 *   4. Clicking the dial opens the probe readout with real local values.
 *   5. The SAPS feedback toggle and layer toggles don't throw.
 *   6. LIVE mode: mocked propagated feed drives the sliders read-only,
 *      verdict card populates, take-over/return/stop all work.
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

        // The 3D sphere is the default view where WebGL exists; the 2D
        // dial is the fallback. Either is a valid boot — but the toggle
        // must always land on a painted dial.
        const view = await page.evaluate(() => window.__shieldingLab.state.view);
        expect(['3d', '2d']).toContain(view);
        await page.click('#sl-view-2d');
        await expect(page.locator('#sl-dial')).toBeVisible();
        await page.waitForTimeout(300); // a frame or two on the dial

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

    test('3D globe view boots when WebGL is available', async ({ page }) => {
        await expect(page.locator('#sl-cpcp')).not.toHaveText('—', { timeout: 20_000 });
        const view = await page.evaluate(() => window.__shieldingLab.state.view);
        test.skip(view !== '3d', 'no WebGL in this environment — 2D fallback took over');
        await expect(page.locator('#sl-globe')).toBeVisible();
        await expect(page.locator('#sl-dial')).toBeHidden();
        // Toggle round-trip keeps both alive.
        await page.click('#sl-view-2d');
        await expect(page.locator('#sl-globe')).toBeHidden();
        await page.click('#sl-view-3d');
        await expect(page.locator('#sl-globe')).toBeVisible();
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

    test('st-patrick replay drives controls and shows validation panel', async ({ page }) => {
        await expect(page.locator('#sl-cpcp')).not.toHaveText('—', { timeout: 20_000 });
        await page.click('#sl-replay-stpatrick2015');
        await expect(page.locator('#sl-scn-status')).toContainText("St. Patrick's", { timeout: 10_000 });
        await expect(page.locator('#sl-validation')).toBeVisible();
        // The replay sets controls from real OMNI data: Bz slider follows
        // (quiet start ≈ +12 nT, not the default −2).
        await page.waitForTimeout(1500);
        const bz = parseFloat(await page.locator('#sl-bz').inputValue());
        expect(bz).toBeGreaterThan(0);
        // HUD shows real UTC.
        await expect(page.locator('#sl-clock')).toContainText('2015-03');
        // Manual slider input cancels the replay.
        await page.locator('#sl-vsw').evaluate((el) => {
            el.value = '500';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await expect(page.locator('#sl-validation')).toBeHidden();
        expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
    });

    test('replay completion reports the validation summary', async ({ page }) => {
        await expect(page.locator('#sl-cpcp')).not.toHaveText('—', { timeout: 20_000 });
        await page.click('#sl-replay-stpatrick2015');
        await expect(page.locator('#sl-validation')).toBeVisible();
        // Shrink the window so the replay finishes in seconds instead of 72 h
        // (drivers still real — we just stop early).
        await page.evaluate(() => {
            window.__shieldingLab.state.replay.durationS = 1200;
        });
        await expect(page.locator('#sl-scn-status')).toContainText('replay complete', { timeout: 30_000 });
        await expect(page.locator('#sl-scn-status')).toContainText('peak CPCP');
        await expect(page.locator('#sl-scn-status')).toContainText('SWMF IE');
        expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
    });

    test('LIVE mode drives, locks sliders, takes over, returns', async ({ page }) => {
        // Mock the SWPC propagated feed (fresh timestamps, lead ahead of
        // wall clock) so the test runs with zero live network.
        const now = Date.now();
        const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
        const header = ['time_tag', 'speed', 'density', 'temperature', 'bx', 'by', 'bz', 'bt', 'propagated_time_tag'];
        const rows = [];
        for (let i = 0; i < 60; i++) {
            const obs = now - (75 - i) * 60_000;
            rows.push([iso(obs), '612', '7.5', '90000', '1.0', '2.0', '-7.5', '8.0', iso(now + (i - 45) * 60_000)]);
        }
        const fixture = [header, ...rows];
        await page.route('**/products/geospace/propagated-solar-wind-1-hour.json', (route) =>
            route.fulfill({ json: fixture }));
        await page.route('**/api/noaa/passthrough**', (route) => route.fulfill({ json: fixture }));
        await page.route('**/api/noaa/radio-flux**', (route) =>
            route.fulfill({ json: { current: { flux_sfu: 145 } } }));

        await expect(page.locator('#sl-cpcp')).not.toHaveText('—', { timeout: 20_000 });
        await page.click('#sl-live-btn');
        await expect(page.locator('#sl-live-btn')).toContainText('stop live');
        // Sliders become read-only live readouts; speed locks at ×1.
        await expect(page.locator('#sl-controls-grid')).toHaveClass(/sl-live-lock/);
        await expect(page.locator('#sl-speed')).toBeDisabled();
        await expect(page.locator('#sl-tau-speed')).toHaveText('×1');
        await expect(page.locator('#sl-verdict')).toBeVisible();

        // ×1 means one solve per 10 wall-seconds — fast-forward the
        // backlog so the first live solve happens now, not in 10 s.
        await page.evaluate(() => { window.__shieldingLab.state.simBacklogS = 10; });
        await expect(page.locator('#sl-verdict-state')).not.toHaveText('—', { timeout: 10_000 });
        await expect(page.locator('#sl-verdict-age')).toContainText('lead');
        await expect(page.locator('#sl-clock')).toContainText('LIVE');
        // The mocked drivers reached the solver: Bz slider follows −7.5.
        const bz = parseFloat(await page.locator('#sl-bz').inputValue());
        expect(bz).toBeCloseTo(-7.5, 1);

        // Take over by grabbing the (locked) slider grid.
        await page.locator('#sl-controls-grid').dispatchEvent('pointerdown');
        await expect(page.locator('#sl-live-btn')).toContainText('return to live');
        await expect(page.locator('#sl-controls-grid')).not.toHaveClass(/sl-live-lock/);

        // One-click return, then a full stop hides the card.
        await page.click('#sl-live-btn');
        await expect(page.locator('#sl-live-btn')).toContainText('stop live');
        await page.click('#sl-live-btn');
        await expect(page.locator('#sl-verdict')).toBeHidden();
        expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
    });

    test('drift-physics R2 mode enables the pressure layer', async ({ page }) => {
        await expect(page.locator('#sl-cpcp')).not.toHaveText('—', { timeout: 20_000 });
        await page.click('#sl-r2-drift');
        await expect(page.locator('#sl-r2-drift')).toHaveClass(/active/);
        await expect(page.locator('#sl-layer-pressure-wrap')).toBeVisible();
        await expect(page.locator('#sl-tau')).toBeDisabled();
        await expect(page.locator('#sl-r2-note')).toContainText('Vasyliunas');
        await page.waitForTimeout(2000); // a few solves in drift mode
        const r2 = parseFloat(await page.locator('#sl-r2').textContent());
        expect(Number.isFinite(r2)).toBe(true);
        await page.click('#sl-r2-relax');
        await expect(page.locator('#sl-layer-pressure-wrap')).toBeHidden();
        expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
    });

    test('probe opens with local values; toggles are safe', async ({ page }) => {
        await expect(page.locator('#sl-cpcp')).not.toHaveText('—', { timeout: 20_000 });
        await page.click('#sl-view-2d'); // probe via the dial's hit-test path
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
