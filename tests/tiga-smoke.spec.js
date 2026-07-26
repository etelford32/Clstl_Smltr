// tests/tiga-smoke.spec.js — browser gate for tiga.html.
//
// Run: npx playwright test tests/tiga-smoke.spec.js
//
// The Node gates under tests/geomag-*.mjs cover the physics. This covers the
// things only a browser can fail:
//
//   • the page boots with a clean console (an ES-module import typo is a
//     silent blank panel, not an error anyone sees in a diff),
//   • all three layers render, and each renders LAZILY — charts are laid out
//     from clientWidth, which is 0 while a panel is display:none, so drawing
//     all three at boot produced 1-pixel-wide canvases,
//   • the live feed being DOWN degrades to the offline experiment instead of
//     breaking the page. That is the whole dropout argument, applied to the
//     page itself, so it is tested with the route deliberately failed.
//
// The USGS route is mocked in every test — this must run without live network.

import { test, expect } from '@playwright/test';

const PAGE = '/tiga.html';

/** Fail the observatory route, the way a dead upstream would. */
async function killFeed(page) {
    await page.route('**/api/geomag/observatories*', (route) =>
        route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"down"}' }));
}

/** Serve a synthetic USGS-shaped window: six usable sites plus one auroral. */
async function mockFeed(page) {
    await page.route('**/api/geomag/observatories*', (route) => {
        const t0 = Date.UTC(2026, 6, 26, 12, 0, 0);
        const times = Array.from({ length: 90 }, (_, i) => new Date(t0 + i * 60000).toISOString());
        const mk = (iaga, lat, lon) => ({
            iaga, name: iaga, geodeticLatitude: lat, geodeticLongitude: lon, times,
            x: times.map((_, i) => 21000
                + (i > 30 ? -90 * (1 - Math.exp(-(i - 30) / 10)) * Math.exp(-(i - 30) / 200) : 0)),
        });
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                source: 'mock',
                data: {
                    updated: new Date(t0 + 90 * 60000).toISOString(),
                    endTime: new Date(t0 + 90 * 60000).toISOString(),
                    requested: 14, returned: 7, missing: ['BSL'],
                    stations: [
                        mk('BOU', 40.137, 254.763), mk('FRD', 38.205, 282.633),
                        mk('TUC', 32.174, 249.267), mk('HON', 21.316, 202.0),
                        mk('SJG', 18.113, 293.849), mk('GUA', 13.588, 144.867),
                        mk('BRW', 71.322, 203.378),   // auroral — must be cut client-side
                    ],
                },
            }),
        });
    });
}

/** Collect page errors and console errors, ignoring the mocked-route noise. */
function watchErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource/i.test(t)) return;   // mocked 503s and favicons
        errors.push(`console: ${t}`);
    });
    return errors;
}

test.describe('tiga.html', () => {
    test('boots clean, and the External layer computes the definition floor offline', async ({ page }) => {
        const errors = watchErrors(page);
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });

        await expect(page.locator('#tg-tab-external')).toHaveAttribute('aria-selected', 'true');

        // The index definition floor is deterministic — the same 11.36 nT the
        // Node gate pins — and it must appear WITHOUT any network.
        await expect(page.locator('#tg-floor-value')).toHaveText(/11\.3[0-9] nT/, { timeout: 30000 });

        // Estimation error must be materially below the floor. That separation
        // is the product argument, so a page that showed otherwise is broken.
        const est = parseFloat((await page.locator('#tg-est-error').textContent()).trim());
        expect(est).toBeGreaterThan(0);
        expect(est).toBeLessThan(11.36 / 2);

        // The T3 identity table: the classical average must equal −q₁⁰ exactly.
        const rows = page.locator('#tg-identity-table tbody tr');
        await expect(rows).toHaveCount(4);
        await expect(rows.first()).toContainText('-87.300000000');

        // The dropout curve must have run and reported a flat result.
        await expect(page.locator('#tg-dropout-status')).toContainText('Flat across', { timeout: 30000 });

        expect(errors).toEqual([]);
    });

    test('a dead feed degrades to the offline experiment instead of breaking', async ({ page }) => {
        const errors = watchErrors(page);
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });

        const status = page.locator('#tg-live-status');
        await expect(status).toHaveClass(/err/, { timeout: 30000 });
        await expect(status).toContainText('Live network unavailable');
        // …and it says WHY that is not a failure of the argument.
        await expect(status).toContainText('runs offline');

        // The offline half is still fully populated.
        await expect(page.locator('#tg-floor-value')).toHaveText(/nT/);
        await expect(page.locator('#tg-cov68')).toHaveText(/%/);
        expect(errors).toEqual([]);
    });

    test('the live nowcast publishes a posterior and cuts auroral stations', async ({ page }) => {
        const errors = watchErrors(page);
        await mockFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });

        // The posterior is the product — a value without a σ is not the deliverable.
        await expect(page.locator('#tg-live-sigma')).toHaveText(/± \d+(\.\d+)? nT/, { timeout: 30000 });
        await expect(page.locator('#tg-live-value')).toHaveText(/-?\d+(\.\d+)? nT/);
        await expect(page.locator('#tg-live-n')).toHaveText('6');   // BRW cut, six kept

        // BRW is listed but dimmed as excluded, with its reason — the cut is on
        // a computed dipole latitude, and the page shows its work.
        const table = page.locator('#tg-station-table tbody');
        await expect(table).toContainText('BOU');
        await expect(table.locator('tr.tg-dim')).toContainText('BRW');
        await expect(table.locator('tr.tg-dim')).toContainText('auroral');

        // The provisional-baseline badge must be present and honest.
        await expect(page.locator('#tg-live-tag')).toHaveText(/Provisional/);
        expect(errors).toEqual([]);
    });

    test('the Field layer evaluates IGRF-14 live and reacts to the epoch slider', async ({ page }) => {
        const errors = watchErrors(page);
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });

        await page.click('[data-layer="field"]');
        await expect(page.locator('#tg-tab-field')).toHaveAttribute('aria-selected', 'true');

        await expect(page.locator('#tg-saa')).toContainText('nT', { timeout: 20000 });
        const saa2026 = await page.locator('#tg-saa').textContent();
        const pole2026 = await page.locator('#tg-pole').textContent();

        // Charts must have real width — a panel drawn while display:none lays
        // out at clientWidth 0 and renders a 1px canvas.
        const w = await page.locator('#tg-field-map').evaluate((c) => c.width);
        expect(w).toBeGreaterThan(200);

        // Move the epoch back 100 years: the SAA and the pole must both move.
        await page.locator('#tg-year').fill('1926');
        await page.locator('#tg-year').dispatchEvent('input');
        await expect(page.locator('#tg-year-out')).toHaveText('1926');
        await expect(page.locator('#tg-saa')).not.toHaveText(saa2026, { timeout: 20000 });
        await expect(page.locator('#tg-pole')).not.toHaveText(pole2026);

        // The dipole tilt phase locks near 17 UT — geometry, not the core.
        await expect(page.locator('#tg-tilt-utmax')).toHaveText(/1[67]\.\d\d UT/);
        expect(errors).toEqual([]);
    });

    test('the Core layer runs the reduced dynamo models', async ({ page }) => {
        const errors = watchErrors(page);
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });

        await page.click('[data-layer="core"]');
        await expect(page.locator('#tg-tab-core')).toHaveAttribute('aria-selected', 'true');

        // Rm ≈ 1135 is the number that says a dynamo is possible at all.
        await expect(page.locator('#tg-numbers-table tbody')).toContainText('1135', { timeout: 20000 });
        // The dipole outlives degree 13 by 16.7×.
        await expect(page.locator('#tg-decay-ratio')).toHaveText('16.7×');
        await expect(page.locator('#tg-decay-table tbody')).toContainText('23,884 yr');
        // Rikitake reverses without being forced.
        const reversals = parseInt(await page.locator('#tg-rev-count').textContent(), 10);
        expect(reversals).toBeGreaterThan(20);

        // The αΩ sweep is opt-in (it is seconds of compute), so it must start
        // in an explicit "not run yet" state rather than showing a stale window.
        await expect(page.locator('#tg-window-lo')).toHaveText('—');
        expect(errors).toEqual([]);
    });

    test('the αΩ sweep finds a one-decade dipole window', async ({ page }) => {
        test.setTimeout(180000);
        const errors = watchErrors(page);
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });
        await page.click('[data-layer="core"]');

        await page.locator('#tg-res').fill('48');
        await page.locator('#tg-res').dispatchEvent('input');
        await page.click('#tg-run-parity');

        await expect(page.locator('#tg-parity-status'))
            .toContainText('Dipole preferred', { timeout: 150000 });

        // The lower edge is essentially resolution-independent; the upper edge
        // converges from above like 1/N², so it is checked as a range.
        const lo = parseFloat(await page.locator('#tg-window-lo').textContent());
        const hi = parseFloat(await page.locator('#tg-window-hi').textContent());
        expect(lo).toBeGreaterThan(105);
        expect(lo).toBeLessThan(125);
        expect(hi).toBeGreaterThan(1100);
        expect(hi).toBeLessThan(1300);
        // ONE DECADE. That is the result: a dipole is not inevitable.
        await expect(page.locator('#tg-window-decades')).toHaveText(/1\.0\d decades/);
        expect(errors).toEqual([]);
    });

    test('every layer carries its honest label', async ({ page }) => {
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });
        // These labels are the point of the page and must not be quietly dropped.
        await expect(page.locator('.tg-layer[data-layer="core"] .tg-tag')).toHaveText('Model');
        await expect(page.locator('.tg-layer[data-layer="field"] .tg-tag')).toHaveText('Observation-derived');
        await expect(page.locator('.tg-layer[data-layer="external"] .tg-tag')).toHaveText('Real-time estimate');
        // And the page must never call itself a geodynamo simulation. The
        // disclaimer lives in the Core panel, so switch to it first — innerText
        // returns only VISIBLE text, and asserting against a display:none panel
        // passes or fails for the wrong reason.
        await page.click('[data-layer="core"]');
        await expect(page.locator('#tg-panel-core')).toBeVisible();
        const core = (await page.locator('#tg-panel-core').innerText()).toLowerCase();
        expect(core).toContain('not a geodynamo simulation');

        // Nowhere on any layer may it claim to simulate one.
        for (const layer of ['core', 'field', 'external']) {
            await page.click(`[data-layer="${layer}"]`);
            const text = (await page.locator('main').innerText()).toLowerCase();
            expect(text).not.toMatch(/simulates? the geodynamo/);
            expect(text).not.toMatch(/geodynamo simulator/);
        }
    });
});
