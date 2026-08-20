/**
 * pollution-lab-smoke.spec.js — browser gate for pollution.html.
 * ═══════════════════════════════════════════════════════════════════════════
 * Boots the Pollution Lab in headless Chromium with all four feeds mocked
 * (deterministic fixtures — CI has no outbound network) and verifies:
 *
 *   1. Page boots: nav mounts, hero renders, all four feed pips go live.
 *   2. Hotspot ML: the cluster list renders ranked k-means clusters from the
 *      mocked city sample, auto-k is reported, clicking selects a cluster.
 *   3. Climate panel: every stat is populated and the global direct forcing
 *      is NEGATIVE (scattering aerosol cools — a sign flip here means the
 *      disclosed constants got mangled).
 *   4. Transport sim: ▶ advances the sim clock; ⟲ resets it to t + 0 h.
 *   5. Mode switch: the forcing view swaps the legend text.
 *   6. Honest degradation: with every feed dead the page runs the bundled
 *      sample and SHOWS THE DEMO BADGE + red pips (feeds down must look
 *      down — flux-rope house rule).
 *   7. Time machine: the history feed lights its pip, the scrubber seeks and
 *      repaints the map + climate numbers, playback advances and stops at the
 *      window end, "worst hour" lands in the HINDCAST half, ⟲ returns to live,
 *      and the Δ-vs-window mode swaps the legend.
 *   8. Time machine degradation: with ONLY the history feed dead, every
 *      time-machine control stays disabled and the strip says so — while the
 *      rest of the lab keeps working, because nothing else depends on it.
 *
 * Runs via `npx playwright test tests/pollution-lab-smoke.spec.js`.
 */

import { test, expect } from '@playwright/test';

const NOW_ISO = () => new Date().toISOString();

const CENTERS_FIXTURE = () => ({
    updated: NOW_ISO(),
    count: 6,
    freshness: 'live',
    provenance: { id: 'open-meteo-cams-global', kind: 'model', label: 'CAMS modeled air quality' },
    cities: [
        { name: 'Delhi', country: 'India', lat: 28.61, lon: 77.21, pop: 32, aqi: 172, pm25: 96, pm10: 180, ozone: 40, no2: 55, aod: 0.85, time: NOW_ISO() },
        { name: 'Lahore', country: 'Pakistan', lat: 31.55, lon: 74.34, pop: 13, aqi: 166, pm25: 88, pm10: 170, ozone: 38, no2: 49, aod: 0.8, time: NOW_ISO() },
        { name: 'Dhaka', country: 'Bangladesh', lat: 23.81, lon: 90.41, pop: 22, aqi: 158, pm25: 74, pm10: 150, ozone: 33, no2: 41, aod: 0.7, time: NOW_ISO() },
        { name: 'New York', country: 'USA', lat: 40.71, lon: -74.01, pop: 19.5, aqi: 42, pm25: 9, pm10: 18, ozone: 60, no2: 18, aod: 0.1, time: NOW_ISO() },
        { name: 'Chicago', country: 'USA', lat: 41.88, lon: -87.63, pop: 8.9, aqi: 48, pm25: 11, pm10: 20, ozone: 55, no2: 20, aod: 0.11, time: NOW_ISO() },
        { name: 'London', country: 'UK', lat: 51.51, lon: -0.13, pop: 14, aqi: 46, pm25: 11, pm10: 19, ozone: 52, no2: 24, aod: 0.12, time: NOW_ISO() },
    ],
    worst: ['Delhi', 'Lahore', 'Dhaka'],
});

const GRID_FIXTURE = () => {
    const points = [];
    for (const lat of [-60, -30, 0, 30, 60]) {
        for (let lon = -160; lon <= 160; lon += 40) {
            points.push({ id: `cams-${points.length}`, lat, lon, aqi: 20, pm25: 4 + Math.abs(lat) / 30, pm10: 9, aod: 0.05 });
        }
    }
    return {
        available: true,
        frame: {
            schema: 'pp.air-quality.frame.v1',
            validAt: NOW_ISO(), retrievedAt: NOW_ISO(),
            provenance: { id: 'open-meteo-cams-global', kind: 'model' },
            scope: { key: 'global-40x30', kind: 'global' },
            units: { aqi: 'AQI', pm25: 'µg/m³' },
            points,
        },
    };
};

const WEATHER_FIXTURE = () => {
    const data = [];
    for (let j = 0; j < 36; j++) {
        for (let i = 0; i < 72; i++) {
            data.push({ current: { wind_speed_10m: 6, wind_direction_10m: 270 } });
        }
    }
    return {
        source: 'open-meteo:72x36',
        fetched_at: NOW_ISO(),
        age_seconds: 120,
        grid: { w: 72, h: 36, deg: 5 },
        data,
    };
};

// History fixture: 30 hourly frames, `now` at 24, so there is a hindcast half
// AND a forecast tail. Delhi carries a deliberate SPIKE at frame 6 (the "worst
// hour" target) and a GAP at frame 10 (which must not render as clean air);
// London carries a bigger spike in the FORECAST half, which must not win the
// worst-hour search or reorder the series ranking.
const HISTORY_COUNT = 30;
const HISTORY_NOW = 24;
const HISTORY_FIXTURE = () => {
    const start = Date.UTC(2026, 7, 19, 0, 0, 0);
    const times = Array.from({ length: HISTORY_COUNT }, (_, i) => start + i * 3_600_000);
    const delhi = times.map((_, i) => (i === 10 ? null : i === 6 ? 210 : 80 + (i % 5) * 3));
    const london = times.map((_, i) => (i > HISTORY_NOW ? 400 : 11 + (i % 4)));
    const dhaka = times.map((_, i) => 60 + (i % 7) * 2);
    return {
        updated: NOW_ISO(),
        freshness: 'live',
        coverage: 0.98,
        variable: 'pm25',
        units: { pm25: 'µg/m³' },
        provenance: { id: 'open-meteo-cams-global', kind: 'model', label: 'CAMS modeled air quality' },
        window: {
            startMs: times[0], endMs: times.at(-1), stepHours: 1,
            count: HISTORY_COUNT, nowIndex: HISTORY_NOW, pastHours: 24, futureHours: 5, clamped: false,
        },
        times,
        cities: [
            { kind: 'city', name: 'Delhi', country: 'India', pop: 32, lat: 28.61, lon: 77.21, coverage: 0.97, series: delhi },
            { kind: 'city', name: 'Dhaka', country: 'Bangladesh', pop: 22, lat: 23.81, lon: 90.41, coverage: 1, series: dhaka },
            { kind: 'city', name: 'London', country: 'UK', pop: 14, lat: 51.51, lon: -0.13, coverage: 1, series: london },
        ],
        background: [-60, -30, 0, 30, 60].flatMap((lat, r) =>
            [-160, -80, 0, 80, 160].map((lon, c) => ({
                kind: 'background', id: `bg-${r}-${c}`, lat, lon, coverage: 1,
                series: times.map(() => 4 + Math.abs(lat) / 30),
            }))),
        counts: { cities: 3, cityRequested: 3, background: 25, backgroundRequested: 25 },
    };
};

const FIRES_FIXTURE = () => ({
    updated: NOW_ISO(),
    count: 2,
    freshness: 'live',
    fires: [
        { id: 'EONET_1', name: 'Ridge Fire', lat: 40.2, lon: -121.2, startedAt: NOW_ISO(), lastUpdate: NOW_ISO(), areaAcres: 8400, ageDays: 0.5, link: null },
        { id: 'EONET_2', name: 'Creek Fire', lat: 34.1, lon: -118.1, startedAt: NOW_ISO(), lastUpdate: NOW_ISO(), areaAcres: 300, ageDays: 2.1, link: null },
    ],
    sources: { eonet: { ok: true, count: 2 } },
});

async function mockFeeds(page) {
    await page.route('**/api/air-quality/centers', r => r.fulfill({ json: CENTERS_FIXTURE() }));
    await page.route('**/api/air-quality/grid*', r => r.fulfill({ json: GRID_FIXTURE() }));
    await page.route('**/api/weather/grid', r => r.fulfill({ json: WEATHER_FIXTURE() }));
    await page.route('**/api/wildfires/events', r => r.fulfill({ json: FIRES_FIXTURE() }));
    await page.route('**/api/air-quality/history*', r => r.fulfill({ json: HISTORY_FIXTURE() }));
    // Base map imagery: abort → the page falls back to its graticule.
    await page.route('**wvs.earthdata.nasa.gov/**', r => r.abort());
}

test.describe('Pollution Lab', () => {
    test('boots live: pips, clusters, climate stats', async ({ page }) => {
        await mockFeeds(page);
        await page.goto('/pollution.html');

        await expect(page.locator('.pl-hero h1')).toContainText('Pollution');
        await expect(page.locator('nav .nav-brand')).toBeVisible();

        for (const id of ['pip-centers', 'pip-grid', 'pip-wind', 'pip-fires', 'pip-history']) {
            await expect(page.locator(`#${id}`)).toHaveClass(/live/, { timeout: 15_000 });
        }
        await expect(page.locator('#pl-demo-badge')).toBeHidden();

        // Hotspot ML: ranked clusters from the fixture; the heavy South-Asia
        // trio must outrank the clean western cities.
        const clusters = page.locator('.pl-cluster');
        await expect(clusters.first()).toBeVisible();
        await expect(page.locator('#out-k')).toContainText('auto');
        await expect(clusters.first()).toContainText(/Delhi|Lahore|Dhaka/);
        await clusters.first().click();
        await expect(clusters.first()).toHaveClass(/sel/);

        // Climate: all stats populated, forcing negative.
        for (const id of ['st-pm', 'st-aod', 'st-forcing', 'st-dt', 'st-local']) {
            await expect(page.locator(`#${id}`)).not.toContainText('—');
        }
        await expect(page.locator('#st-forcing')).toContainText('-');
        await expect(page.locator('#st-dt')).toContainText('-');
    });

    test('transport sim runs and resets; forcing mode swaps the legend', async ({ page }) => {
        await mockFeeds(page);
        await page.goto('/pollution.html');
        await expect(page.locator('#pip-centers')).toHaveClass(/live/, { timeout: 15_000 });

        await page.click('#btn-play');
        await expect(page.locator('#pl-sim-clock')).toBeVisible();
        await expect(page.locator('#pl-sim-clock')).not.toContainText('t + 0 h', { timeout: 10_000 });
        await page.click('#btn-play');            // pause
        await page.click('#btn-reset');
        await expect(page.locator('#pl-sim-clock')).toContainText('t + 0 h');

        await expect(page.locator('#pl-legend')).toContainText('PM2.5');
        await page.click('#btn-mode-forcing');
        await expect(page.locator('#pl-legend')).toContainText('direct forcing');
    });

    test('time machine: scrub, play, worst hour, return to live', async ({ page }) => {
        await mockFeeds(page);
        await page.goto('/pollution.html');
        await expect(page.locator('body')).toHaveAttribute('data-pl-ready', '1', { timeout: 15_000 });

        // Controls come alive only once a real window loaded.
        for (const id of ['btn-time-play', 'btn-time-step-back', 'btn-time-step-fwd',
            'btn-time-now', 'btn-time-peak', 'btn-mode-anomaly']) {
            await expect(page.locator(`#${id}`)).toBeEnabled();
        }
        // Parked at `now`, still showing the LIVE field — the scrubber does not
        // hijack the map until it is touched.
        await expect(page.locator('#pl-time-stamp')).toContainText('live now');
        await expect(page.locator('#pl-timeline')).toHaveAttribute('aria-valuemax', String(HISTORY_COUNT - 1));

        // Series panel: three mocked metros, ranked dirtiest-first, with the
        // window statistics beside them.
        const rows = page.locator('#pl-series-rows .r');
        await expect(rows.first()).toContainText('Delhi');
        for (const id of ['st-win-mean', 'st-win-peak', 'st-win-trend']) {
            await expect(page.locator(`#${id}`)).not.toContainText('—');
        }
        await expect(page.locator('#pl-diurnal-who')).toContainText('Delhi');

        // Seeking repaints the map field AND the climate numbers: the whole
        // page follows one index. Frame 6 is the fixture's dirtiest hindcast
        // hour, so the area-weighted mean must rise above the live reading.
        const meanAt = async () => parseFloat(await page.locator('#st-pm').textContent());
        const liveMean = await meanAt();
        await page.evaluate(() => window.__pollutionLab.seek(6));
        await expect(page.locator('#pl-time-stamp')).toContainText('hindcast');
        expect(await meanAt()).toBeGreaterThan(liveMean);

        // A GAP must read as a gap, not as clean air. Delhi has no hour 10.
        await page.evaluate(() => window.__pollutionLab.seek(10));
        await expect(rows.filter({ hasText: 'Delhi' })).toContainText('no CAMS hour');

        // The forecast half is labelled as forecast wherever it is reported.
        await page.evaluate(i => window.__pollutionLab.seek(i), HISTORY_NOW + 3);
        await expect(page.locator('#pl-time-stamp')).toContainText('forecast');

        // "worst hour" searches the HINDCAST only — London's 400 µg/m³ spike
        // lives in the forecast tail and must not win.
        await page.click('#btn-time-peak');
        const peakIdx = await page.evaluate(() => window.__pollutionLab.state.time.index);
        expect(peakIdx).toBeLessThanOrEqual(HISTORY_NOW);
        expect(peakIdx).toBe(6);

        // Playback advances the index and stops AT the end rather than looping.
        await page.evaluate(i => window.__pollutionLab.seek(i), HISTORY_COUNT - 4);
        await page.click('#btn-time-play');
        await expect(page.locator('#btn-time-play')).toContainText('Pause');
        await expect.poll(
            () => page.evaluate(() => window.__pollutionLab.state.time.index),
            { timeout: 10_000 },
        ).toBe(HISTORY_COUNT - 1);
        await expect(page.locator('#btn-time-play')).toContainText('Play history');

        // Δ vs window needs the history window, and swaps the legend.
        await page.click('#btn-mode-anomaly');
        await expect(page.locator('#pl-legend')).toContainText('window mean');
        await page.click('#btn-mode-pm');

        // ⟲ leaves history mode entirely, not just the transport clock.
        await page.click('#btn-reset');
        await expect(page.locator('#pl-time-stamp')).toContainText('live now');
        expect(await page.evaluate(() => window.__pollutionLab.state.time.active)).toBe(false);
        expect(await meanAt()).toBeCloseTo(liveMean, 1);
    });

    test('history alone dead → controls disabled, rest of the lab unaffected', async ({ page }) => {
        await mockFeeds(page);
        await page.route('**/api/air-quality/history*', r => r.abort());
        await page.goto('/pollution.html');
        await expect(page.locator('body')).toHaveAttribute('data-pl-ready', '1', { timeout: 15_000 });

        await expect(page.locator('#pip-history')).toHaveClass(/err/);
        await expect(page.locator('#pl-time-stamp')).toContainText('unavailable');
        for (const id of ['btn-time-play', 'btn-time-step-back', 'btn-time-step-fwd',
            'btn-time-now', 'btn-time-peak', 'btn-mode-anomaly']) {
            await expect(page.locator(`#${id}`)).toBeDisabled();
        }
        // Everything that never depended on the history window still works.
        await expect(page.locator('#pip-centers')).toHaveClass(/live/);
        await expect(page.locator('.pl-cluster').first()).toBeVisible();
        await expect(page.locator('#st-forcing')).not.toContainText('—');
        await page.click('#btn-play');
        await expect(page.locator('#pl-sim-clock')).not.toContainText('t + 0 h', { timeout: 10_000 });
    });

    test('all feeds dead → DEMO badge + red pips, lab still explorable', async ({ page }) => {
        await page.route('**/api/**', r => r.abort());
        await page.route('**wvs.earthdata.nasa.gov/**', r => r.abort());
        await page.goto('/pollution.html');

        await expect(page.locator('#pl-demo-badge')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#pip-centers')).toHaveClass(/err/);
        await expect(page.locator('#pip-wind')).toHaveClass(/warn/);   // synthetic circulation
        await expect(page.locator('#pip-history')).toHaveClass(/err/);
        // No history means no scrubber — the page must not fabricate a window
        // to keep its new chrome looking alive.
        await expect(page.locator('#btn-time-play')).toBeDisabled();
        await expect(page.locator('#pl-time-stamp')).toContainText('unavailable');
        // The bundled sample still clusters — the lab works, honestly badged.
        await expect(page.locator('.pl-cluster').first()).toBeVisible();
        for (const id of ['st-pm', 'st-forcing']) {
            await expect(page.locator(`#${id}`)).not.toContainText('—');
        }
    });
});
