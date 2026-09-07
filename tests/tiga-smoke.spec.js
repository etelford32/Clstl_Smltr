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
    // The page genuinely COMPUTES on boot — the External layer runs the full
    // observing-system experiment before it can print the definition floor, and
    // the Core layer solves a diffusion problem. Under parallel workers that
    // contends with the 3D test and can exceed a 30s assertion timeout; the
    // suite showed exactly one flake there. Raising the budget is the honest
    // fix (the work is real and CI runners are slower than this one) rather
    // than retrying until it passes.
    test.slow();

    test('boots clean, and the External layer computes the definition floor offline', async ({ page }) => {
        const errors = watchErrors(page);
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });

        await expect(page.locator('#tg-tab-external')).toHaveAttribute('aria-selected', 'true');

        // The index definition floor is deterministic — the same 11.36 nT the
        // Node gate pins — and it must appear WITHOUT any network.
        await expect(page.locator('#tg-floor-value')).toHaveText(/11\.3[0-9] nT/, { timeout: 60000 });

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
        await expect(page.locator('#tg-dropout-status')).toContainText('Flat across', { timeout: 60000 });

        expect(errors).toEqual([]);
    });

    test('a dead feed degrades to the offline experiment instead of breaking', async ({ page }) => {
        const errors = watchErrors(page);
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });

        const status = page.locator('#tg-live-status');
        await expect(status).toHaveClass(/err/, { timeout: 60000 });
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
        await expect(page.locator('#tg-live-sigma')).toHaveText(/± \d+(\.\d+)? nT/, { timeout: 60000 });
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
        await expect(floor).toHaveAttribute('role', 'img', { timeout: 60000 });
        const label = await floor.getAttribute('aria-label');
        expect(label).toMatch(/11\.3\d nanotesla/);       // the definition floor
        expect(label.length).toBeGreaterThan(60);

        await expect(page.locator('#tg-dropout-chart'))
            .toHaveAttribute('aria-label', /stations/, { timeout: 60000 });

        // Status regions must announce async results rather than changing silently.
        await expect(page.locator('#tg-live-status')).toHaveAttribute('aria-live', 'polite');
        await expect(page.locator('#tg-dropout-status')).toHaveAttribute('aria-live', 'polite');

        // And the lazily-drawn panels label their charts too, once drawn.
        await page.click('[data-layer="field"]');
        await expect(page.locator('#tg-field-map'))
            .toHaveAttribute('aria-label', /South Atlantic Anomaly/, { timeout: 60000 });
    });

    test('the page never scrolls horizontally, at any width', async ({ page }) => {
        // The repo rule: wide content scrolls inside its own container, the
        // body never does. Four-column numeric tables overflowed a 390px
        // viewport by 14px — a sideways-scrolling page on every phone.
        await killFeed(page);
        for (const width of [390, 768, 1024]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(PAGE, { waitUntil: 'load' });
            await expect(page.locator('#tg-floor-value')).toHaveText(/nT/, { timeout: 60000 });
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

    test('the 3D core view mounts and its numbers come from the kernels', async ({ page }) => {
        test.setTimeout(180000);
        const errors = watchErrors(page);
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });
        await page.click('[data-layer="core"]');

        // WebGL may be unavailable on a runner. The scene is dynamically
        // imported so that degrades to a message rather than taking the whole
        // Core layer down — and the layer's other content must be intact
        // either way, since all of it is pure computation.
        const msg = page.locator('#tg-stage-msg');
        await page.waitForFunction(
            () => !document.getElementById('tg-stage-msg')
                || /unavailable/.test(document.getElementById('tg-stage-msg').textContent),
            null, { timeout: 90000 });

        const failed = (await msg.count()) > 0;
        if (failed) {
            await expect(msg).toContainText('unaffected');
        } else {
            await expect(page.locator('#tg-stage canvas')).toHaveCount(1);
            // Peak |B_r| at the CMB is ~800 µT — roughly an order of magnitude
            // above the surface field, which is the continuation doing its job.
            const peak = parseFloat(await page.locator('#tg-3d-peak').textContent());
            expect(peak).toBeGreaterThan(300);
            expect(peak).toBeLessThan(2000);
            // Reversed flux is a real, bounded quantity — an inverted sign
            // convention showed up as ~80% and it must not come back.
            const rev = parseFloat(await page.locator('#tg-3d-reversed').textContent());
            expect(rev).toBeGreaterThan(2);
            expect(rev).toBeLessThan(45);
            // Some traced lines escape the core and some close inside it.
            await expect(page.locator('#tg-3d-lines')).toHaveText(/\d+ \/ \d+/);
            await expect(page.locator('#tg-3d-status')).toContainText('L-shell');
        }

        // The diffusion solve runs regardless of WebGL — it is pure JS.
        await expect(page.locator('#tg-decay-live-legend')).toContainText('degree 1 at 100.0%');
        await page.locator('#tg-decay-time').fill('12000');
        await page.locator('#tg-decay-time').dispatchEvent('input');
        // THE RESULT: the dipole survives where the high degrees do not.
        await expect(page.locator('#tg-decay-live-legend'))
            .toContainText(/degree 1 at [456]\d\.\d%/, { timeout: 60000 });
        const legend = await page.locator('#tg-decay-live-legend').textContent();
        const hi = parseFloat(legend.match(/degree 13 at ([\d.]+)%/)[1]);
        expect(hi).toBeLessThan(2);

        expect(errors).toEqual([]);
    });

    test('the layer cutaway opens toward the camera and survives orbiting', async ({ page }) => {
        test.setTimeout(180000);
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });
        await page.click('[data-layer="core"]');
        await page.waitForFunction(
            () => !document.getElementById('tg-stage-msg')
                || /unavailable/.test(document.getElementById('tg-stage-msg').textContent),
            null, { timeout: 90000 });
        if (await page.locator('#tg-stage-msg').count()) test.skip(true, 'no WebGL on this runner');

        // Switching to the layer stack must auto-open the cut. Showing a
        // layered body intact is the least informative view of it there is.
        await page.selectOption('#tg-3d-interior', 'layers');
        await expect(page.locator('#tg-3d-cut-out')).not.toHaveText('0%');

        // The cut plane is re-derived from the CAMERA every frame. A world-fixed
        // plane means orbiting 180° puts the opening behind the body, so the
        // control only works from one angle.
        //
        // Asserting the INVARIANT directly rather than dragging: the plane
        // normal must point opposite the camera's azimuth, so
        // normal.x = −x/√(x²+z²). A synthetic drag tests whether Playwright can
        // reach OrbitControls, which is not the behaviour under test.
        const check = async () => page.evaluate(() => {
            const s = window.__tigaScene;
            if (!s) return null;
            const p = s.camera.position;
            const len = Math.hypot(p.x, p.z) || 1;
            return { nx: s.clipPlane.normal.x, want: -p.x / len, constant: s.clipPlane.constant };
        });

        const a = await check();
        expect(a).not.toBeNull();
        expect(Math.abs(a.nx - a.want)).toBeLessThan(0.02);

        // The offset slider, not a synthetic drag: a drag tests whether
        // Playwright can reach OrbitControls, which is not the behaviour under
        // test. (Writing camera.position directly DOES take effect — r160's
        // update() re-derives its spherical from the camera every frame — but
        // going through the control that a user actually has is the point.)
        await page.locator('#tg-3d-cutaz').fill('90');
        await page.locator('#tg-3d-cutaz').dispatchEvent('input');
        await page.waitForTimeout(500);
        const b = await check();
        // A 90° offset must rotate the normal 90° from the camera-facing one.
        expect(Math.abs(b.nx - a.nx)).toBeGreaterThan(0.3);
        expect(Math.hypot(b.nx, 0)).toBeLessThanOrEqual(1.001);

        await page.locator('#tg-3d-cutaz').fill('0');
        await page.locator('#tg-3d-cutaz').dispatchEvent('input');
        await page.waitForTimeout(500);
        const back = await check();
        expect(Math.abs(back.nx - back.want)).toBeLessThan(0.02);

        // Opening the cut further must push the plane toward the centre.
        await page.locator('#tg-3d-cut').fill('100');
        await page.locator('#tg-3d-cut').dispatchEvent('input');
        await page.waitForTimeout(400);
        const c = await check();
        expect(c.constant).toBeLessThan(back.constant);
        expect(c.constant).toBeCloseTo(0, 5);   // a full hemisphere removed
    });

    test('the layer table shows exactly one dynamo-capable shell', async ({ page }) => {
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });
        await page.click('[data-layer="core"]');

        const rows = page.locator('#tg-layerdiag-table tbody tr');
        await expect(rows).toHaveCount(5, { timeout: 30000 });
        // Exactly one layer clears Rm ≈ 40 — and it is not the most conductive
        // one, it is the only one that MOVES.
        await expect(page.locator('#tg-layerdiag-table tbody tr.tg-hi')).toHaveCount(1);
        await expect(page.locator('#tg-layerdiag-table tbody tr.tg-hi')).toContainText('Outer core');
        await expect(page.locator('#tg-layerdiag-table tbody')).toContainText('magnetisable');

        // The two numbers the callouts quote must be live, not hard-coded prose.
        await expect(page.locator('#tg-ic-tau')).toHaveText(/6,0\d\d-year/);
        await expect(page.locator('#tg-tc-lat')).toHaveText(/69\.\d°/);
    });

    test('controls that cannot act are visibly disabled, not silently inert', async ({ page }) => {
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });
        await page.waitForFunction(
            () => !document.getElementById('tg-stage-msg')
                || /unavailable/.test(document.getElementById('tg-stage-msg').textContent),
            null, { timeout: 90000 });
        if (await page.locator('#tg-stage-msg').count()) test.skip(true, 'no WebGL on this runner');

        // The clip plane is attached only to the layer-shell materials, and the
        // mantle shell is forced transparent while the layer stack is open. So
        // each of these sliders is genuinely inert in one mode — and a control
        // that looks live and does nothing reads as a broken app rather than as
        // a setting that does not apply here.
        await expect(page.locator('#tg-3d-cut')).toBeDisabled();
        await expect(page.locator('#tg-3d-cutaz')).toBeDisabled();
        await expect(page.locator('#tg-3d-mantle')).toBeEnabled();

        await page.selectOption('#tg-3d-interior', 'layers');
        await expect(page.locator('#tg-3d-cut')).toBeEnabled();
        await expect(page.locator('#tg-3d-cutaz')).toBeEnabled();
        await expect(page.locator('#tg-3d-mantle')).toBeDisabled();

        // Disabled is not enough on its own — it has to say WHY.
        const row = page.locator('#tg-3d-mantle').locator('xpath=ancestor::div[contains(@class,"tg-field")][1]');
        await expect(row).toHaveAttribute('title', /layer stack/);

        await page.selectOption('#tg-3d-interior', 'field');
        await expect(page.locator('#tg-3d-cut')).toBeDisabled();
        await expect(page.locator('#tg-3d-mantle')).toBeEnabled();
    });

    test('the key is mode-aware and its swatches match the real materials', async ({ page }) => {
        test.setTimeout(180000);
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });
        await page.waitForFunction(
            () => !document.getElementById('tg-stage-msg')
                || /unavailable/.test(document.getElementById('tg-stage-msg').textContent),
            null, { timeout: 90000 });
        if (await page.locator('#tg-stage-msg').count()) test.skip(true, 'no WebGL on this runner');

        const labels = () => page.locator('#tg-key-body li .tg-key-lb')
            .evaluateAll((els) => els.map((e) => e.firstChild.textContent.trim()));

        // External: observatories are on screen, core-closed field lines are not.
        await expect(page.locator('#tg-key')).toBeVisible();
        let l = await labels();
        expect(l).toContain('Observatory, N');
        expect(l).not.toContain('Field line, closes in core');

        // Core: the closed lines ARE on screen, the observatories are not. A
        // static key listing everything the scene CAN draw would be wrong in
        // every mode, because most of it is not visible in any given one.
        await page.click('[data-layer="core"]');
        l = await labels();
        expect(l).toContain('Field line, closes in core');
        expect(l).not.toContain('Observatory, N');

        // Layer structure: five shells plus the tangent cylinder, each carrying
        // its conductivity and its dynamo verdict.
        await page.selectOption('#tg-3d-interior', 'layers');
        l = await labels();
        expect(l).toEqual(['Inner core', 'Outer core', 'Lower mantle', 'Upper mantle', 'Crust',
            'Tangent cylinder']);
        await expect(page.locator('#tg-key-body')).toContainText('σ 1e+6 S/m · dynamo');

        // THE SWATCHES MUST MATCH THE MATERIALS. A key with its own hard-coded
        // colours is a second source of truth that drifts the moment anyone
        // retunes a material — silently, because both still render.
        const mismatches = await page.evaluate(() => {
            const P = window.__tigaScene.palettes;
            const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
            const want = Object.fromEntries(
                Object.entries(P.LAYER_PALETTE).map(([k, v]) => [k, hex(v.color)]));
            want['Tangent cylinder'] = hex(P.TANGENT_CYLINDER_COLOR);
            return [...document.querySelectorAll('#tg-key-body li')]
                .map((li) => {
                    const name = li.querySelector('.tg-key-lb').firstChild.textContent.trim();
                    const got = li.querySelector('.tg-key-sw').dataset.color;
                    return want[name] && want[name] !== got ? `${name}: ${got} vs ${want[name]}` : null;
                })
                .filter(Boolean);
        });
        expect(mismatches).toEqual([]);

        // Collapsible, and it says so to a screen reader.
        await expect(page.locator('#tg-key-toggle')).toHaveAttribute('aria-expanded', 'true');
        await page.click('#tg-key-toggle');
        await expect(page.locator('#tg-key-toggle')).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('#tg-key-body')).toBeHidden();
    });

    test('opening the layer stack cuts deep enough to expose the inner core', async ({ page }) => {
        test.setTimeout(180000);
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });
        await page.waitForFunction(
            () => !document.getElementById('tg-stage-msg')
                || /unavailable/.test(document.getElementById('tg-stage-msg').textContent),
            null, { timeout: 90000 });
        if (await page.locator('#tg-stage-msg').count()) test.skip(true, 'no WebGL on this runner');

        await page.selectOption('#tg-3d-interior', 'layers');
        await page.waitForTimeout(600);
        // The clip constant must land INSIDE the inner core (0.192 R_E), or the
        // cutaway looks open and reveals nothing — which is what a 55% default
        // did: the plane sat at 0.56, outside the outer core entirely.
        const constant = await page.evaluate(() => window.__tigaScene.clipPlane.constant);
        expect(constant).toBeLessThan(0.192);
        expect(constant).toBeGreaterThanOrEqual(0);
    });

    /**
     * ── THE CAMERA ────────────────────────────────────────────────────────
     *
     * The regression this whole test exists for: render() used to ease
     * camera.position toward the active layer's framing distance EVERY FRAME,
     * forever, and OrbitControls reads the camera position back at the top of
     * its own update() — so a scroll moved the camera and the page put it back
     * about a second later. "Zoom works" therefore cannot be tested by zooming
     * and reading the result immediately; the assertion has to be that the
     * zoom is STILL there after the old spring would have eaten it.
     */
    async function bootStage(page, layer) {
        await killFeed(page);
        await page.goto(PAGE, { waitUntil: 'load' });
        if (layer) await page.click(`[data-layer="${layer}"]`);
        await page.waitForFunction(
            () => !document.getElementById('tg-stage-msg')
                || /unavailable/.test(document.getElementById('tg-stage-msg').textContent),
            null, { timeout: 90000 });
        if (await page.locator('#tg-stage-msg').count()) return false;
        await page.waitForFunction(() => typeof window.__tigaCamera === 'function');
        // Clicking a layer tab scrolls the SPINE into view, which puts the
        // stage off the top of the window — and the page pauses GL when the
        // stage is offscreen, on purpose. Without scrolling back, the flight
        // never advances and every camera assertion below waits forever.
        await page.locator('#tg-stage').scrollIntoViewIfNeeded();
        await page.waitForFunction(
            () => { const c = window.__tigaCamera(); return c && !c.flying; },
            null, { timeout: 45000 });
        return true;
    }

    test('a zoom the user asks for is still there a second later', async ({ page }) => {
        test.setTimeout(180000);
        if (!await bootStage(page, 'core')) test.skip(true, 'no WebGL on this runner');

        const framed = await page.evaluate(() => window.__tigaCamera());
        expect(framed.dist).toBeGreaterThan(1.2);
        expect(framed.dist).toBeLessThan(2.6);

        // A REAL wheel event, not a method call — the whole failure was in how
        // the page reacted to the controls, so the controls have to be in the
        // loop.
        const box = await page.locator('#tg-stage canvas').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -900);
        await page.waitForTimeout(150);
        const zoomed = await page.evaluate(() => window.__tigaCamera().dist);
        expect(zoomed).toBeLessThan(framed.dist * 0.8);

        // The old spring pulled the camera back at 7% per frame: 2 s is ~120
        // frames, which took it to within 0.03% of the layer default. If this
        // assertion fails, the standing ease is back.
        await page.waitForTimeout(2000);
        const held = await page.evaluate(() => window.__tigaCamera().dist);
        expect(Math.abs(held - zoomed)).toBeLessThan(0.02);

        // Zooming out again must also stick, in the other direction.
        await page.mouse.wheel(0, 900);
        await page.waitForTimeout(1600);
        const out = await page.evaluate(() => window.__tigaCamera().dist);
        expect(out).toBeGreaterThan(zoomed + 0.05);
    });

    test('the near plane rides the distance so close range does not clip', async ({ page }) => {
        test.setTimeout(180000);
        if (!await bootStage(page, 'core')) test.skip(true, 'no WebGL on this runner');

        // A fixed 0.05 near plane against a 0.14 minimum distance puts the
        // clip a third of the way to the pivot — the inner core loses its
        // front half at exactly the zoom where someone got interested.
        await page.evaluate(() => window.__tigaScene.zoomBy(0.01));   // clamps to the floor
        await page.waitForTimeout(400);
        const near = await page.evaluate(() => window.__tigaCamera());
        expect(near.dist).toBeLessThan(0.3);
        expect(near.near).toBeLessThan(near.dist * 0.05);
        // Far only has to clear the scene (2.2 R_E of field line plus the pan
        // bound); a fixed 100 is depth precision spent on empty space.
        expect(near.far).toBeLessThan(12);

        await page.evaluate(() => window.__tigaScene.zoomBy(200));    // clamps to the ceiling
        await page.waitForTimeout(400);
        const far = await page.evaluate(() => window.__tigaCamera());
        expect(far.dist).toBeGreaterThan(20);
        expect(far.near).toBeGreaterThan(near.near);
        expect(far.far).toBeGreaterThan(far.dist);
    });

    test('panning moves the pivot, and Recentre brings it home', async ({ page }) => {
        test.setTimeout(180000);
        if (!await bootStage(page, 'field')) test.skip(true, 'no WebGL on this runner');

        const start = await page.evaluate(() => window.__tigaCamera().targetRadius);
        expect(start).toBeLessThan(0.01);

        const box = await page.locator('#tg-stage canvas').boundingBox();
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down({ button: 'right' });
        for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 12, cy + i * 4);
        await page.mouse.up({ button: 'right' });
        await page.waitForTimeout(900);

        // Panning was OFF before this change, so "explore the scene" meant
        // "orbit the centre of the Earth and nothing else".
        const panned = await page.evaluate(() => window.__tigaCamera().targetRadius);
        expect(panned).toBeGreaterThan(0.02);
        // …but bounded, so a pan can never lose the planet.
        expect(panned).toBeLessThanOrEqual(2.61);

        await page.click('.tg-nav-btn[data-view="recentre"]');
        await page.waitForFunction(
            () => { const c = window.__tigaCamera(); return c && !c.flying; },
            null, { timeout: 30000 });
        expect(await page.evaluate(() => window.__tigaCamera().targetRadius)).toBeLessThan(0.01);
    });

    test('a framing flight yields to the user instead of fighting them', async ({ page }) => {
        test.setTimeout(180000);
        if (!await bootStage(page, 'core')) test.skip(true, 'no WebGL on this runner');

        // Start a long flight, then interrupt it one frame later. The camera
        // must stop where the user left it, not resume its trip.
        await page.evaluate(() => window.__tigaScene.flyTo({ dist: 26 }));
        await page.waitForTimeout(120);
        const box = await page.locator('#tg-stage canvas').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(60);
        expect(await page.evaluate(() => window.__tigaCamera().flying)).toBe(false);

        const stopped = await page.evaluate(() => window.__tigaCamera().dist);
        // It stopped where the user left it, and it never got to the goal.
        expect(stopped).toBeLessThan(25);
        await page.waitForTimeout(1500);
        const later = await page.evaluate(() => window.__tigaCamera().dist);
        expect(Math.abs(later - stopped)).toBeLessThan(0.02);

        // Reset is how you get the framing back — deliberately, not by waiting.
        await page.click('.tg-nav-btn[data-view="reset"]');
        await page.waitForFunction(
            () => { const c = window.__tigaCamera(); return c && !c.flying; },
            null, { timeout: 30000 });
        const home = await page.evaluate(() => window.__tigaCamera().dist);
        expect(Math.abs(home - 1.55)).toBeLessThan(0.05);   // LAYER_VIEW.core.dist
    });

    test('the keyboard can drive the view', async ({ page }) => {
        test.setTimeout(180000);
        if (!await bootStage(page, 'core')) test.skip(true, 'no WebGL on this runner');

        // A data surface only a mouse can reach is a WCAG 2.1.1 failure, and
        // this one carries readings.
        await page.locator('#tg-stage canvas').focus();
        const before = await page.evaluate(() => {
            const p = window.__tigaScene.camera.position;
            return { x: p.x, y: p.y, z: p.z };
        });
        for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(200);
        const after = await page.evaluate(() => {
            const p = window.__tigaScene.camera.position;
            return { x: p.x, y: p.y, z: p.z };
        });
        expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.05);

        const d0 = await page.evaluate(() => window.__tigaCamera().dist);
        for (let i = 0; i < 4; i++) await page.keyboard.press('=');
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => window.__tigaCamera().dist)).toBeLessThan(d0 * 0.9);

        await page.keyboard.press('r');
        await page.waitForFunction(
            () => { const c = window.__tigaCamera(); return c && !c.flying; },
            null, { timeout: 30000 });
        expect(Math.abs(await page.evaluate(() => window.__tigaCamera().dist) - 1.55)).toBeLessThan(0.05);
    });

    test('hovering reads the field from the kernel, and says nothing below the CMB', async ({ page }) => {
        test.setTimeout(180000);
        // External layer: the surface shell is the visible one, so a pick at
        // the middle of the disc lands on it.
        if (!await bootStage(page, 'external')) test.skip(true, 'no WebGL on this runner');

        const box = await page.locator('#tg-stage canvas').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForFunction(() => window.__tigaCamera()?.probe, null, { timeout: 20000 });

        const probe = await page.evaluate(() => window.__tigaCamera().probe);
        expect(['surface', 'observatory']).toContain(probe.kind);
        // Earth's surface field runs 22–67 µT. A probe that read the shader's
        // colormap back instead of the kernel could not land in that window.
        expect(probe.fNt).toBeGreaterThan(20000);
        expect(probe.fNt).toBeLessThan(70000);
        expect(Math.abs(probe.latDeg)).toBeLessThanOrEqual(90);
        expect(Math.abs(probe.lonDeg)).toBeLessThanOrEqual(180);
        await expect(page.locator('#tg-readout-probe')).toBeVisible();
        await expect(page.locator('#tg-readout-probe')).toContainText(/nT|µT/);
        await expect(page.locator('#tg-readout-hint')).toBeHidden();

        // Now the inner core, which is INSIDE the source region. IGRF is a
        // potential field and continuing it into its own source currents is
        // not a measurement — the readout must say so rather than print an
        // authoritative-looking number.
        //
        // Reaching it means getting inside the CMB: the CMB shell is at 0.546
        // R_E and the inner core at 0.192, so from outside, a centred ray hits
        // the CMB first and reports the CMB field — which is correct, and is
        // the headline quantity of this page.
        await page.click('[data-layer="core"]');
        await page.locator('#tg-stage').scrollIntoViewIfNeeded();
        await page.waitForFunction(
            () => { const c = window.__tigaCamera(); return c && !c.flying; },
            null, { timeout: 45000 });
        await page.evaluate(() => window.__tigaScene.zoomBy(0.22));
        await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForFunction(
            () => window.__tigaCamera()?.probe?.kind === 'inner', null, { timeout: 20000 });
        const inner = await page.evaluate(() => window.__tigaCamera().probe);
        expect(inner.brNt).toBeUndefined();
        expect(inner.note).toMatch(/cannot be continued below/);
        await expect(page.locator('#tg-readout-probe')).toContainText('core–mantle boundary');

        // Leaving the canvas puts the hint back.
        await page.mouse.move(box.x + box.width / 2, box.y - 40);
        await expect(page.locator('#tg-readout-hint')).toBeVisible();
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
