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

/**
 * Collect page errors and console errors.
 *
 * Two classes are filtered, both narrowly and for a stated reason — a broad
 * filter here would quietly swallow the import typos this check exists to catch:
 *
 *  1. Resource-load failures. The observatory route is deliberately mocked to
 *     503 in most of these tests, and favicons/manifests are absent locally.
 *  2. The shared nav's OPTIONAL Supabase client, which it lazy-imports from a
 *     CDN. Mounting the site nav on this page (it previously had none, which
 *     was the bug) brought that dependency with it, and the CDN is unreachable
 *     from a sandboxed test runner. It is third-party and outside this page's
 *     control; auth is not part of what tiga.html does. Anything else — including
 *     any error naming a js/geomag module — still fails the test.
 */
function watchErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource/i.test(t)) return;
        if (/\[Supabase\].*(cdn\.jsdelivr\.net|supabase-js)/i.test(t)) return;
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

    test('the site navigation actually mounts', async ({ page }) => {
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });

        // REGRESSION GATE. initNav() does `document.querySelector('nav')` and
        // returns early when there is none — it POPULATES a shell, it does not
        // create one. This page shipped once without the shell: no console
        // error, nothing in the diff, and no navigation on the page at all.
        // Asserting the <nav> tag exists is not enough, because an empty shell
        // looks identical in the markup — assert it got FILLED.
        await expect(page.locator('nav')).toHaveCount(1);
        await expect(page.locator('nav a').first()).toBeVisible();
        expect(await page.locator('nav a').count()).toBeGreaterThan(20);
        await expect(page.locator('#nav-burger')).toHaveCount(1);

        // The skip link must reach the main landmark.
        const target = await page.locator('.skip-link').getAttribute('href');
        expect(target).toBe('#main-content');
        await expect(page.locator('#main-content')).toHaveCount(1);
    });

    test('the layer tabs follow the ARIA tabs keyboard pattern', async ({ page }) => {
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });

        const tabs = page.locator('.tg-layer');
        // Roving tabindex: exactly one tab in the tab order, not three.
        const tabIndexes = await tabs.evaluateAll((els) => els.map((e) => e.tabIndex));
        expect(tabIndexes.filter((t) => t === 0)).toHaveLength(1);

        await page.locator('#tg-tab-external').focus();
        await page.keyboard.press('ArrowRight');   // wraps to the first tab
        await expect(page.locator('#tg-tab-core')).toHaveAttribute('aria-selected', 'true');
        // Arrow keys must MOVE FOCUS as well as selection, or a keyboard user
        // is stranded on the tab they started from.
        expect(await page.evaluate(() => document.activeElement.dataset.layer)).toBe('core');

        await page.keyboard.press('End');
        await expect(page.locator('#tg-tab-external')).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Home');
        await expect(page.locator('#tg-tab-core')).toHaveAttribute('aria-selected', 'true');

        // Panels must be focusable so focus can land inside them.
        await expect(page.locator('#tg-panel-core')).toHaveAttribute('tabindex', '0');

        // The toggle groups announce their state.
        await expect(page.locator('#tg-field-tabs button[aria-pressed="true"]')).toHaveCount(1);
        await expect(page.locator('#tg-alias-tabs button[aria-pressed="true"]')).toHaveCount(1);
    });

    test('charts carry text alternatives with the actual numbers in them', async ({ page }) => {
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });

        // A <canvas> is an empty element to a screen reader. Every chart that
        // has been drawn must carry role="img" and a label containing the
        // finding, not just "chart".
        const floor = page.locator('#tg-floor-chart');
        await expect(floor).toHaveAttribute('role', 'img', { timeout: 30000 });
        const label = await floor.getAttribute('aria-label');
        expect(label).toMatch(/11\.3\d nanotesla/);       // the definition floor
        expect(label.length).toBeGreaterThan(60);

        await expect(page.locator('#tg-dropout-chart'))
            .toHaveAttribute('aria-label', /stations/, { timeout: 30000 });

        // Status regions must announce async results rather than changing silently.
        await expect(page.locator('#tg-live-status')).toHaveAttribute('aria-live', 'polite');
        await expect(page.locator('#tg-dropout-status')).toHaveAttribute('aria-live', 'polite');

        // And the lazily-drawn panels label their charts too, once drawn.
        await page.click('[data-layer="field"]');
        await expect(page.locator('#tg-field-map'))
            .toHaveAttribute('aria-label', /South Atlantic Anomaly/, { timeout: 30000 });
    });

    test('the page never scrolls horizontally, at any width', async ({ page }) => {
        // The repo rule: wide content scrolls inside its own container, the
        // body never does. Four-column numeric tables overflowed a 390px
        // viewport by 14px — a sideways-scrolling page on every phone.
        await killFeed(page);
        for (const width of [390, 768, 1024]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(PAGE, { waitUntil: 'load' });
            await expect(page.locator('#tg-floor-value')).toHaveText(/nT/, { timeout: 30000 });
            const doc = await page.evaluate(() => document.documentElement.scrollWidth);
            expect(doc, `body scrolls horizontally at ${width}px`).toBeLessThanOrEqual(width);
        }

        // The tables that would otherwise overflow must be inside a keyboard-
        // reachable scroll region — a box only a finger can pan fails 2.1.1.
        const regions = page.locator('.tg-scroll');
        expect(await regions.count()).toBeGreaterThan(0);
        await expect(regions.first()).toHaveAttribute('tabindex', '0');
        await expect(regions.first()).toHaveAttribute('aria-label', /.+/);
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
