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
    // Base map imagery: abort → the page falls back to its graticule.
    await page.route('**wvs.earthdata.nasa.gov/**', r => r.abort());
}

test.describe('Pollution Lab', () => {
    test('boots live: pips, clusters, climate stats', async ({ page }) => {
        await mockFeeds(page);
        await page.goto('/pollution.html');

        await expect(page.locator('.pl-hero h1')).toContainText('Pollution');
        await expect(page.locator('nav .nav-brand')).toBeVisible();

        for (const id of ['pip-centers', 'pip-grid', 'pip-wind', 'pip-fires']) {
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

    test('all feeds dead → DEMO badge + red pips, lab still explorable', async ({ page }) => {
        await page.route('**/api/**', r => r.abort());
        await page.route('**wvs.earthdata.nasa.gov/**', r => r.abort());
        await page.goto('/pollution.html');

        await expect(page.locator('#pl-demo-badge')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#pip-centers')).toHaveClass(/err/);
        await expect(page.locator('#pip-wind')).toHaveClass(/warn/);   // synthetic circulation
        // The bundled sample still clusters — the lab works, honestly badged.
        await expect(page.locator('.pl-cluster').first()).toBeVisible();
        for (const id of ['st-pm', 'st-forcing']) {
            await expect(page.locator(`#${id}`)).not.toContainText('—');
        }
    });
});
