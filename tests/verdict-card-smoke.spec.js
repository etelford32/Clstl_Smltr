/**
 * verdict-card-smoke.spec.js — smoke test for the EarthView verdict card
 * ═══════════════════════════════════════════════════════════════════════════
 * Boots earth.html in headless Chromium with a saved location pre-seeded and
 * the two Open-Meteo endpoints mocked (deterministic fixtures — CI has no
 * outbound network), then verifies the card's contract:
 *
 *   1. The card mounts at #verdict-host by default (no flag needed) and
 *      renders all sections: verdict word, 6 factor chips, temp graph,
 *      week grid, tonight's-sky rows, local stats, CTA + Explore,
 *      provenance — and it is the ONE location panel (#hud + #loc-panel
 *      are hidden while it is active).
 *   2. Factor chips carry real values from the mocked feed (not '--').
 *   3. Dragging the header by pointer moves the card and persists position.
 *   4. Explore › collapses to the pill; the pill restores the card AND
 *      is itself a drag handle (a minimised card must stay movable).
 *   5. The location editor row geocodes a typed query, personalises the
 *      card, auto-flies the camera, and stops auto-rotation on arrival.
 *   6. ?verdict=0 disables the card entirely and restores the classic
 *      #loc-panel + #hud chrome (opt-out contract).
 *
 * Runs via `npx playwright test tests/verdict-card-smoke.spec.js`.
 */

import { test, expect } from '@playwright/test';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Open-Meteo forecast fixture: 48 h hourly + 8 daily rows, unixtime. */
function wxFixture(nowMs) {
    const start = Math.floor(nowMs / HOUR) * HOUR;
    const hours = 48;
    const time = [], temperature_2m = [], precipitation_probability = [], cloud_cover = [], uv_index = [];
    for (let i = 0; i < hours; i++) {
        time.push((start + i * HOUR) / 1000);
        // Prototype-shaped: 90° cooling to 66° overnight, back up by day.
        temperature_2m.push(78 + 12 * Math.cos((i / 24) * 2 * Math.PI));
        precipitation_probability.push(0);
        cloud_cover.push(12);
        uv_index.push(Math.max(0, 9 * Math.sin(((i - 6) / 24) * Math.PI)));
    }
    // Local midnight (fixture tz is PDT = UTC−7).
    const d = new Date(nowMs - 7 * HOUR);
    const day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7);
    const daily = { time: [], temperature_2m_max: [], temperature_2m_min: [], weather_code: [], cloud_cover_mean: [], precipitation_probability_max: [] };
    for (let i = 0; i < 8; i++) {
        daily.time.push((day0 + i * DAY) / 1000);
        daily.temperature_2m_max.push(90 + i % 3);
        daily.temperature_2m_min.push(66 + i % 3);
        daily.weather_code.push(i === 2 ? 2 : 0);
        daily.cloud_cover_mean.push(i === 5 ? 80 : 15);
        daily.precipitation_probability_max.push(0);
    }
    return {
        timezone: 'America/Los_Angeles',
        hourly: { time, temperature_2m, precipitation_probability, cloud_cover, uv_index },
        daily,
    };
}

/**
 * Open-Meteo air-quality fixture: 24 h history + 24 h forecast at a fixed AQI.
 *
 * The component values must be COHERENT with us_aqi: the card's headline is
 * EPA NowCast rebuilt from these hourly series, so a fixture whose us_aqi and
 * whose PM2.5 imply different indices would assert one number while exercising
 * another. A flat 7.5 µg/m³ of PM2.5 gives NowCast weight 1 (plain mean) →
 * 7.5 → AQI 42, matching us_aqi, with PM2.5 the dominant sub-index
 * (pm10 16, O3 33, NO2 6, CO 1, SO2 0).
 */
function aqFixture(nowMs) {
    const start = Math.floor(nowMs / HOUR) * HOUR;
    const time = [], us_aqi = [], pm2_5 = [], pm10 = [], ozone = [];
    const nitrogen_dioxide = [], sulphur_dioxide = [], carbon_monoxide = [];
    const aerosol_optical_depth = [], dust = [];
    // 24 h of history + the current hour + 24 h of forecast, matching the
    // real request (past_days=1). The history is REQUIRED: EPA NowCast needs
    // 2 of the 3 most recent hours and the 8-h means need 6 of 8, so a
    // forecast-only fixture silently exercises the upstream fallback instead
    // of the path the card actually takes in production.
    for (let i = 0; i < 49; i++) {
        time.push((start + (i - 24) * HOUR) / 1000);
        us_aqi.push(42);
        pm2_5.push(7.5); pm10.push(17.2); ozone.push(71.5);
        nitrogen_dioxide.push(12.3); sulphur_dioxide.push(2.1); carbon_monoxide.push(184);
        aerosol_optical_depth.push(0.086); dust.push(4.7);
    }
    return {
        hourly_units: {
            pm2_5: 'µg/m³', pm10: 'µg/m³', ozone: 'µg/m³',
            nitrogen_dioxide: 'µg/m³', sulphur_dioxide: 'µg/m³',
            carbon_monoxide: 'µg/m³', aerosol_optical_depth: '', dust: 'µg/m³',
        },
        hourly: { time, us_aqi, pm2_5, pm10, ozone, nitrogen_dioxide,
            sulphur_dioxide, carbon_monoxide, aerosol_optical_depth, dust },
    };
}

async function bootWithCard(page, url = '/earth.html') {
    const now = Date.now();
    await page.addInitScript(() => {
        localStorage.setItem('ppx_user_location', JSON.stringify({
            lat: 38.76, lon: -121.16, city: 'Granite Bay', displayName: 'Granite Bay, CA',
        }));
        localStorage.removeItem('ev_verdict_collapsed');
        localStorage.removeItem('earth-panel-pos-ev-verdict-card');
    });
    await page.route('**/api.open-meteo.com/**', r => r.fulfill({ json: wxFixture(now) }));
    await page.route('**/air-quality-api.open-meteo.com/**', r => r.fulfill({ json: aqFixture(now) }));
    // Flux-rope 3-day outlook (Phase 4): the page fills a third sky row when
    // the DONKI catalog carries an Earth-directed CME. Abort the route by
    // default so the baseline contract (exactly 2 sky rows) is hermetic —
    // the outlook path has its own fixture-driven test below.
    await page.route('**/api/donki/**', r => r.abort());
    await page.goto(url, { waitUntil: 'load' });
}

test.describe('EarthView verdict card', () => {

    test('renders the full card from mocked feeds', async ({ page }) => {
        await bootWithCard(page);
        const card = page.locator('#ev-verdict-card');
        await expect(card).toBeVisible({ timeout: 30_000 });

        // Header personalises from the saved location.
        await expect(card.locator('[data-ev="loc-name"]')).toHaveText('Granite Bay', { timeout: 20_000 });
        await expect(card.locator('[data-ev="loc-coords"]')).toContainText('38.76°N');

        // Verdict word + temp-first sentence.
        await expect(card.locator('.ev-verdict-word')).not.toHaveText('');
        await expect(card.locator('.ev-verdict-sentence')).toContainText('° now', { timeout: 20_000 });

        // Six factor chips with real values from the fixtures.
        await expect(card.locator('.ev-verdict-factor')).toHaveCount(6);
        await expect(card.locator('[data-ev-chip="clouds"] .ev-verdict-fval')).toHaveText('12%');
        await expect(card.locator('[data-ev-chip="aqi"] .ev-verdict-fval')).toHaveText('42');
        await expect(card.locator('[data-ev-chip="aqi"] .ev-verdict-fcat')).toHaveText('good');

        // Temp graph, week grid (7 days), moon strip (7), sky rows (2).
        await expect(card.locator('.ev-verdict-tgraph svg')).toHaveCount(1);
        await expect(card.locator('.ev-verdict-day')).toHaveCount(7);
        await expect(card.locator('.ev-verdict-moon')).toHaveCount(7);
        await expect(card.locator('.ev-verdict-skyrow')).toHaveCount(2);

        // Actions + provenance line.
        await expect(card.locator('.ev-verdict-cta')).toBeVisible();
        await expect(card.locator('.ev-verdict-explore')).toBeVisible();
        await expect(card.locator('.ev-verdict-prov')).toContainText('NOAA SWPC');
        await expect(card.locator('.ev-verdict-prov')).toContainText('May 2024 G5');

        // Location editor: input pre-filled from the saved location, with
        // the Fly here / Clear buttons showing (location is set).
        await expect(card.locator('[data-ev="loc-input"]')).toHaveValue('Granite Bay');
        await expect(card.locator('[data-ev="loc-fly"]')).toBeVisible();
        await expect(card.locator('[data-ev="loc-clear"]')).toBeVisible();

        // Local stats block: sun card + clock strip carry real values.
        await expect(card.locator('.ev-verdict-stats')).toBeAttached();
        await expect(card.locator('.ev-verdict-statcard').first()).toContainText('Day length');
        await expect(card.locator('[data-ev="stat-utc"]')).not.toHaveText('--');

        // The card is the ONE location panel: legacy chrome is hidden.
        await expect(page.locator('#hud')).toBeHidden();
        await expect(page.locator('#loc-panel')).toBeHidden();
    });

    test('drags by the header and persists position', async ({ page }) => {
        await bootWithCard(page);
        const card = page.locator('#ev-verdict-card');
        await expect(card).toBeVisible({ timeout: 30_000 });

        const head = card.locator('.ev-verdict-head');
        const box = await head.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + 10);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 140, box.y + 110, { steps: 8 });
        await page.mouse.up();

        const left = await card.evaluate(el => parseFloat(el.style.left));
        const top = await card.evaluate(el => parseFloat(el.style.top));
        expect(left).toBeGreaterThan(100);
        expect(top).toBeGreaterThan(150);

        const stored = await page.evaluate(() => localStorage.getItem('earth-panel-pos-ev-verdict-card'));
        expect(stored).toBeTruthy();
        expect(JSON.parse(stored).left).toBeCloseTo(left, 0);
    });

    test('Explore collapses to pill; pill restores', async ({ page }) => {
        await bootWithCard(page);
        const card = page.locator('#ev-verdict-card');
        await expect(card.locator('.ev-verdict-explore')).toBeVisible({ timeout: 30_000 });

        await card.locator('.ev-verdict-explore').click();
        await expect(card).toHaveClass(/ev-collapsed/);
        await expect(card.locator('[data-ev="pill"]')).toBeVisible();
        await expect(card.locator('.ev-verdict-scroll')).toBeHidden();

        // Collapsed state persists the choice.
        expect(await page.evaluate(() => localStorage.getItem('ev_verdict_collapsed'))).toBe('1');

        await card.locator('[data-ev="pill"]').click();
        await expect(card).not.toHaveClass(/ev-collapsed/);
        await expect(card.locator('.ev-verdict-word')).toBeVisible();
    });

    test('collapsed pill is a drag handle — the minimised card stays movable', async ({ page }) => {
        await bootWithCard(page);
        const card = page.locator('#ev-verdict-card');
        await expect(card.locator('.ev-verdict-explore')).toBeVisible({ timeout: 30_000 });
        await card.locator('.ev-verdict-explore').click();

        const pill = card.locator('[data-ev="pill"]');
        await expect(pill).toBeVisible();
        // The Explore click may have auto-scrolled the window (the button
        // sits near the card's bottom edge); raw mouse coordinates below
        // need the pill actually inside the viewport.
        await pill.scrollIntoViewIfNeeded();
        const box = await pill.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2 + 120, { steps: 8 });
        await page.mouse.up();

        const left = await card.evaluate(el => parseFloat(el.style.left));
        const top = await card.evaluate(el => parseFloat(el.style.top));
        expect(left).toBeGreaterThan(100);
        expect(top).toBeGreaterThan(150);
        const stored = await page.evaluate(() => localStorage.getItem('earth-panel-pos-ev-verdict-card'));
        expect(stored).toBeTruthy();

        // A drag must not eat the pill's click-to-expand for good.
        await pill.click();
        await expect(card).not.toHaveClass(/ev-collapsed/);
    });

    test('typing a location personalises the card, flies, and stops rotation', async ({ page }) => {
        await page.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({
            json: [{
                lat: '40.7128', lon: '-74.0060',
                display_name: 'New York, NY, USA',
                address: { city: 'New York' },
            }],
        }));
        await bootWithCard(page);
        const card = page.locator('#ev-verdict-card');
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('#lyr-rotate')).toBeChecked();

        const input = card.locator('[data-ev="loc-input"]');
        await input.fill('New York');
        await input.press('Enter');

        await expect(card.locator('[data-ev="loc-name"]')).toHaveText('New York', { timeout: 15_000 });
        await expect(card.locator('[data-ev="loc-coords"]')).toContainText('40.71°N');
        // Auto-fly landed → the fly pipeline turns auto-rotation off (and
        // syncs the Layers checkbox), so the framed location stays framed.
        await expect(page.locator('#lyr-rotate')).not.toBeChecked({ timeout: 15_000 });
    });

    test('factor chips expand predictive detail graphs', async ({ page }) => {
        // Six sequential pointer actions on a WebGL page: under software GL
        // each click's frame-stability check can take tens of seconds, and
        // the default 60 s budget dies mid-sequence. Slow-test multiplier
        // (3×) instead of trimming the interaction coverage.
        test.slow();
        await bootWithCard(page);
        const card = page.locator('#ev-verdict-card');
        await expect(card.locator('[data-ev-chip="aqi"] .ev-verdict-fval')).toHaveText('42', { timeout: 30_000 });

        // AQI chip → detail panel with an SVG graph + EPA category summary.
        await card.locator('[data-ev-chip="aqi"]').click();
        await expect(card.locator('[data-ev="detail"]')).toBeVisible();
        await expect(card.locator('[data-ev="detail"]')).toContainText('Air quality');
        await expect(card.locator('[data-ev="detail"] svg')).toHaveCount(1);
        await expect(card.locator('[data-ev="detail"]')).toContainText('now 42 (good)');
        await expect(card.locator('[data-ev="pollution-breakdown"]')).toBeVisible();
        await expect(card.locator('[data-ev-pollutant="pm25"]')).toContainText('7.5');
        await expect(card.locator('[data-ev-pollutant="aerosolOpticalDepth"]')).toContainText('0.086');
        await expect(card.locator('[data-ev="pollution-breakdown"]')).toContainText('not a ground-monitor observation');
        await expect(card.locator('[data-ev-chip="aqi"]')).toHaveAttribute('aria-expanded', 'true');

        // Switching chips swaps the graph in place.
        await card.locator('[data-ev-chip="clouds"]').click();
        await expect(card.locator('[data-ev="detail"]')).toContainText('Cloud cover');
        await expect(card.locator('[data-ev-chip="clouds"]')).toHaveAttribute('aria-expanded', 'true');
        await expect(card.locator('[data-ev-chip="aqi"]')).toHaveAttribute('aria-expanded', 'false');

        // Moon needs no feed at all — pure math series.
        await card.locator('[data-ev-chip="moon"]').click();
        await expect(card.locator('[data-ev="detail"]')).toContainText('Moon illumination');

        // Re-clicking the open chip closes the panel; ✕ also closes.
        await card.locator('[data-ev-chip="moon"]').click();
        await expect(card.locator('[data-ev="detail"]')).toHaveCount(0);
        await card.locator('[data-ev-chip="uv"]').click();
        await expect(card.locator('[data-ev="detail"]')).toBeVisible();
        await expect(card.locator('[data-ev="detail"]')).toContainText('UV index');
        await card.locator('[data-ev-detail-close]').click();
        await expect(card.locator('[data-ev="detail"]')).toHaveCount(0);
    });

    test('?verdict=0 disables the card', async ({ page }) => {
        await bootWithCard(page, '/earth.html?verdict=0');
        // Give the lazy-init window time to (not) fire.
        await page.waitForTimeout(4_000);
        await expect(page.locator('#ev-verdict-card')).toHaveCount(0);
        // The host stays present-but-empty; the classic UI is untouched —
        // opting out restores the standalone location panel and HUD.
        await expect(page.locator('#loc-panel')).toBeAttached();
        await expect(page.locator('#loc-panel')).toBeVisible();
        await expect(page.locator('#hud')).toBeVisible();
    });

    test('flux-rope outlook adds a third sky row for an inbound CME', async ({ page }) => {
        // Phase 4: fixture an Earth-directed DONKI cone launched 6 h ago —
        // the shared provider runs the REAL ensemble WASM in-page and the
        // card appends the storm-outlook sky row (aurora/ISS stay [0]/[1]).
        const launch = new Date(Date.now() - 6 * HOUR).toISOString().slice(0, 19) + 'Z';
        const donki = {
            data: {
                cmes: [{
                    time: launch, speed_km_s: 1400, latitude_deg: -2, longitude_deg: 3,
                    half_angle_deg: 45, earth_directed: true, most_accurate: true,
                }],
            },
        };
        const now = Date.now();
        await page.addInitScript(() => {
            localStorage.setItem('ppx_user_location', JSON.stringify({
                lat: 38.76, lon: -121.16, city: 'Granite Bay', displayName: 'Granite Bay, CA',
            }));
        });
        await page.route('**/api.open-meteo.com/**', r => r.fulfill({ json: wxFixture(now) }));
        await page.route('**/air-quality-api.open-meteo.com/**', r => r.fulfill({ json: aqFixture(now) }));
        await page.route('**/api/donki/**', r => r.fulfill({ json: donki }));
        // No live L1 for the filter — prior-only is the deterministic path.
        await page.route('**/services.swpc.noaa.gov/json/rtsw/**', r => r.abort());
        await page.goto('/earth.html', { waitUntil: 'load' });

        const card = page.locator('#ev-verdict-card');
        await expect(card).toBeVisible({ timeout: 30_000 });
        // The fill runs ~4 s after mount + a ~1 s in-page ensemble.
        await expect(card.locator('.ev-verdict-skyrow')).toHaveCount(3, { timeout: 60_000 });
        const outlook = card.locator('.ev-verdict-skyrow').nth(2);
        await expect(outlook).toContainText(/CME (watch|warning|arriving)/i);
        await expect(outlook).toContainText(/P\(hit\)|storm potential/);
    });
});
