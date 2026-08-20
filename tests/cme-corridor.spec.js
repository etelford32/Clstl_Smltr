// cme-corridor.spec.js — browser gate for the 3D Sun→Earth corridor on
// cme-forecast.html.
//
// The corridor joins three programmes that fail independently — far-side
// holography, the shared flux-rope provider, and NOAA's region list — so what
// this pins is mostly HONESTY under partial failure. A scene that renders
// beautifully with two dead feeds is the regression that matters: it looks
// like a forecast and is a screensaver.
//
// Every route is mocked, so no test depends on DONKI, NOAA or Supabase.

import { test, expect } from '@playwright/test';

const ENV_NOISE = /Failed to load resource|ERR_TUNNEL|ERR_FAILED|ERR_NAME|Supabase|favicon|WebGL|THREE/;

const now = Date.now();
const iso = (h) => new Date(now + h * 3600e3).toISOString();

const LEDGER = { data: {
    updated: iso(-0.25),
    models: [{ model_id: 'flux-rope-v1', is_hindcast: false, n_scored: 5, mae_hours: 7.6, bias_hours: -1.4, hits_12h: 4 }],
    events: [{
        event_id: 'PP-LIVE-X12', donki_id: 'd1', launch: iso(-15), speed_kms: 1180,
        forecasts: { 'flux-rope-v1': {
            issued_at: iso(-14.5), predicted: iso(31), early: iso(24), late: iso(39),
            p_hit: 0.82, p10: 0.63, p20: 0.36, min_bz_p50: -17, min_bz_p5: -34,
            flare: { class: 'X1.2', region: 14126 },
        } },
        truth: null,
    }],
} };

// A NOAA disc with areas ascending alongside SWPC's own flare probabilities.
const REGIONS = { data: { updated: new Date(now).toISOString(), region_count: 5, regions: [
    { region: 14101, area: 20, m_flare_probability: 1 },
    { region: 14102, area: 80, m_flare_probability: 5 },
    { region: 14103, area: 240, m_flare_probability: 15 },
    { region: 14104, area: 600, m_flare_probability: 35 },
    { region: 14105, area: 1400, m_flare_probability: 60 },
] } };

// Two Earth-directed CMEs a few hours apart — a compounding train, the case
// the corridor exists to draw.
//
// This is the SHAPE /api/donki/cme SERVES, not NASA's raw payload: the edge
// route normalizes to data.cmes with snake_case fields, and parseDonkiCmes
// reads that. Mocking the upstream shape instead produces zero parsed CMEs
// and an idle provider — which renders as an honest empty corridor and would
// have made this test quietly assert nothing.
const DONKI = { data: { cmes: [
    {
        time: new Date(now - 19 * 3600e3).toISOString(), cme_id: 'CME-001',
        speed_km_s: 1150, latitude_deg: 6, longitude_deg: -12, half_angle_deg: 45,
        earth_directed: true, most_accurate: true, note: '',
    },
    {
        time: new Date(now - 12 * 3600e3).toISOString(), cme_id: 'CME-002',
        speed_km_s: 820, latitude_deg: -4, longitude_deg: 8, half_angle_deg: 38,
        earth_directed: true, most_accurate: true, note: '',
    },
] } };

async function routeAll(page, { donki = DONKI, regions = REGIONS } = {}) {
    await page.route('**/api/cme/skill**', (r) => r.fulfill({
        contentType: 'application/json', body: JSON.stringify(LEDGER) }));
    await page.route('**/api/noaa/regions**', (r) => regions
        ? r.fulfill({ contentType: 'application/json', body: JSON.stringify(regions) })
        : r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"down"}' }));
    await page.route('**/api/donki/cme**', (r) => donki
        ? r.fulfill({ contentType: 'application/json', body: JSON.stringify(donki) })
        : r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"down"}' }));
    // Far-side archive empty → the page falls back to its labelled synthetic
    // field, which is the deployed reality until the ingest cron has run.
    await page.route('**/api/solar/farside**', (r) => r.fulfill({
        status: 501, contentType: 'application/json', body: '{"error":"not_ready"}' }));
}

async function openCorridor(page) {
    await page.click('[data-cmef-view="corridor"]');
    await page.waitForSelector('#cmef-corridor-host[data-corridor-ready="true"]', { timeout: 40_000 });
}

test.describe('CME forecast 3D corridor', () => {
    let errors;

    test.beforeEach(async ({ page }) => {
        errors = [];
        page.on('console', (m) => {
            if (m.type() === 'error' && !ENV_NOISE.test(m.text())) errors.push(m.text());
        });
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.addInitScript(() => {
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch { /* ignore */ }
        });
    });

    test('the calendar stays the default and pays nothing for 3D', async ({ page }) => {
        await routeAll(page);
        const three = [];
        page.on('request', (r) => { if (/three\.module|corridor-|flux-rope-forecast/.test(r.url())) three.push(r.url()); });

        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#cmef-calendar-grid .cmef-day')).toHaveCount(42);
        await expect(page.locator('#cmef-view-calendar')).toBeVisible();
        await expect(page.locator('#cmef-view-corridor')).toBeHidden();
        await expect(page.locator('[data-cmef-view="calendar"]')).toHaveAttribute('aria-selected', 'true');

        // The heavy stack — three.js, the corridor, the WASM ensemble — must
        // not load until someone asks for the 3D view.
        await page.waitForTimeout(1500);
        expect(three, `loaded eagerly: ${three.join(', ')}`).toHaveLength(0);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('draws the Sun, the source regions and the compounding train', async ({ page }) => {
        await routeAll(page);
        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });
        await openCorridor(page);

        await expect(page.locator('#cmc-canvas')).toHaveAttribute('data-ready', 'true');
        await expect(page.locator('#cmef-calendar-title')).toHaveText('Sun → Earth corridor');

        // Feed chips are the honesty surface: they must say what is actually up.
        const feeds = page.locator('#cmc-feeds');
        await expect(feeds).toContainText('far side');
        await expect(feeds).toContainText('demo');         // synthetic field, labelled
        await expect(feeds).toContainText('CME train');
        await expect(feeds).not.toContainText('CME train · down');

        // The scene really has content: a Sun, source markers, and rope meshes
        // built from the provider's train.
        const scene = await page.evaluate(() => {
            const w = window.__corridorProbe;
            return w ? w() : null;
        });
        expect(scene, 'corridor probe').toBeTruthy();
        expect(scene.sources).toBeGreaterThan(0);
        expect(scene.ropes, 'the compounding train is drawn').toBeGreaterThan(0);

        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('the clock sweeps regions while the train holds its heading', async ({ page }) => {
        await routeAll(page);
        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });
        await openCorridor(page);

        const at = () => page.evaluate(() => window.__corridorProbe());
        const before = await at();

        // Scrub forward four days.
        await page.evaluate(() => {
            const s = document.getElementById('cmc-scrub');
            s.value = String(Math.min(1, parseFloat(s.value) + 4 / 34.2753));
            s.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await expect(page.locator('#cmc-offset')).not.toHaveText('now');
        const after = await at();

        // L0 advanced at the synodic rate — the observer moved.
        const dL0 = ((after.L0 - before.L0 + 540) % 360) - 180;
        expect(Math.abs(dL0 + 4 * 13.199)).toBeLessThan(3);

        // Regions co-rotate: their central-meridian distances all advanced.
        expect(after.firstSourceCmd).not.toBeCloseTo(before.firstSourceCmd, 1);

        // Launched ropes do NOT co-rotate — their headings are ballistic.
        expect(after.ropeHeadings).toEqual(before.ropeHeadings);
        // ...but they have travelled further.
        expect(after.leadApexAu).toBeGreaterThan(before.leadApexAu);

        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('a dead provider shows no train rather than a fabricated one', async ({ page }) => {
        await routeAll(page, { donki: null, regions: null });
        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });
        await openCorridor(page);

        await expect(page.locator('#cmc-feeds')).toContainText('CME train · down');
        await expect(page.locator('#cmc-feeds')).toContainText('flare base rate · down');

        const scene = await page.evaluate(() => window.__corridorProbe());
        expect(scene.ropes, 'no rope is invented without a forecast').toBe(0);
        // The far-side half still works — one dead feed does not blank the scene.
        expect(scene.sources).toBeGreaterThan(0);
        // And no flare caption is printed when the base rate is unavailable.
        expect(scene.flareCaptions).toBe(0);

        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('true scale is reachable and the compression is disclosed', async ({ page }) => {
        await routeAll(page);
        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });
        await openCorridor(page);

        await expect(page.locator('.cmc-disclose')).toContainText('log-compressed');
        await expect(page.locator('.cmc-disclose')).toContainText('true AU');

        const compressed = await page.evaluate(() => window.__corridorProbe().earthX);
        await page.click('#cmc-truescale');
        await expect(page.locator('#cmc-truescale')).toHaveAttribute('aria-pressed', 'true');
        const trueScale = await page.evaluate(() => window.__corridorProbe().earthX);
        // Earth lands at EARTH_S either way — that is the map's fixed point —
        // so the toggle is verified by the RULER moving, not Earth.
        expect(trueScale).toBeCloseTo(compressed, 3);
        const ruler = await page.evaluate(() => window.__corridorProbe().rulerRadii);
        // At true scale the 0.25 AU ring sits at a quarter of Earth's distance.
        expect(ruler[1] / ruler[4]).toBeCloseTo(0.25, 2);

        expect(errors, errors.join('\n')).toHaveLength(0);
    });
});
