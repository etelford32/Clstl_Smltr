/**
 * earth-pollution-layers.spec.js — gate for the two Environment toggles on
 * EarthView: Pollution Centers (live AQI rings) and Wildfire Events (EONET).
 * ═══════════════════════════════════════════════════════════════════════════
 * Boots earth.html (verdict card off to keep the boot light) with the two
 * feeds mocked, then verifies the toggle contract end to end:
 *
 *   1. Both checkbox rows exist in the AIR QUALITY & POLLUTION section and
 *      default OFF with their layer groups hidden (synthetic-change sync).
 *   2. Enabling each toggle fetches its feed, populates the layer
 *      (window.__pollutionCentersLayer / window.__wildfireLayer), makes the
 *      group visible, and writes a live count pill.
 *   3. A stale feed (freshness:'stale') drives the pill to its error state —
 *      a dead upstream must never render as a quiet healthy layer.
 *
 * Runs via `npx playwright test tests/earth-pollution-layers.spec.js`.
 */

import { test, expect } from '@playwright/test';

const NOW_ISO = () => new Date().toISOString();

const CENTERS_FIXTURE = {
    updated: NOW_ISO(), count: 3, freshness: 'live',
    provenance: { id: 'open-meteo-cams-global', kind: 'model' },
    cities: [
        { name: 'Delhi', country: 'India', lat: 28.61, lon: 77.21, pop: 32, aqi: 172, pm25: 96, aod: 0.85, time: NOW_ISO() },
        { name: 'New York', country: 'USA', lat: 40.71, lon: -74.01, pop: 19.5, aqi: 42, pm25: 9, aod: 0.1, time: NOW_ISO() },
        { name: 'London', country: 'UK', lat: 51.51, lon: -0.13, pop: 14, aqi: 46, pm25: 11, aod: 0.12, time: NOW_ISO() },
    ],
    worst: ['Delhi'],
};

const FIRES_FIXTURE = {
    updated: NOW_ISO(), count: 2, freshness: 'live',
    fires: [
        { id: 'EONET_1', name: 'Ridge Fire', lat: 40.2, lon: -121.2, startedAt: NOW_ISO(), lastUpdate: NOW_ISO(), areaAcres: 8400, ageDays: 0.5, link: null },
        { id: 'EONET_2', name: 'Creek Fire', lat: 34.1, lon: -118.1, startedAt: NOW_ISO(), lastUpdate: NOW_ISO(), areaAcres: 300, ageDays: 2.1, link: null },
    ],
    sources: { eonet: { ok: true, count: 2 } },
};

// Toggle a layer checkbox programmatically (value + change event — the same
// contract the pointer path exercises). Pointer check() must wait for the
// row to be "stable", and rows below a live count pill shift as the pill's
// text changes width — under software-GL load that stability check can
// starve past any budget. The FIRST toggle in each test stays a real
// pointer check() so clickability is still proven once per boot.
const setToggle = (page, id, on) => page.evaluate(([elId, want]) => {
    const el = document.getElementById(elId);
    if (el.checked !== want) {
        el.checked = want;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
}, [id, on]);

test.describe('EarthView pollution + wildfire toggles', () => {
    test('toggles load their layers and report counts', async ({ page }) => {
        test.setTimeout(240_000);       // one earth.html boot under software GL
        await page.route('**/api/air-quality/centers', r => r.fulfill({ json: CENTERS_FIXTURE }));
        await page.route('**/api/wildfires/events', r => r.fulfill({ json: FIRES_FIXTURE }));
        await page.goto('/earth.html?verdict=0');

        // Layers construct late in boot; the window handles are the signal.
        await page.waitForFunction(
            () => window.__pollutionCentersLayer && window.__wildfireLayer,
            null, { timeout: 45_000 });

        // 1. Default state: rows exist, boxes unchecked, groups hidden.
        await expect(page.locator('#lyr-pollution-centers')).not.toBeChecked();
        await expect(page.locator('#lyr-wildfires')).not.toBeChecked();
        expect(await page.evaluate(() => window.__pollutionCentersLayer.group.visible)).toBe(false);
        expect(await page.evaluate(() => window.__wildfireLayer.group.visible)).toBe(false);

        // 2. Enable pollution centers → feed loads, group shows, pill counts.
        await page.check('#lyr-pollution-centers');
        await page.waitForFunction(
            () => window.__pollutionCentersLayer.centers.length === 3, null, { timeout: 15_000 });
        expect(await page.evaluate(() => window.__pollutionCentersLayer.group.visible)).toBe(true);
        await expect(page.locator('#pollution-centers-count')).toContainText('3');
        await expect(page.locator('#pollution-centers-count')).toContainText('Delhi 172');

        // Enable wildfires → same contract. (Programmatic: the row sits
        // below the pollution pill whose text just changed width.)
        await setToggle(page, 'lyr-wildfires', true);
        await page.waitForFunction(
            () => window.__wildfireLayer.fires.length === 2, null, { timeout: 15_000 });
        expect(await page.evaluate(() => window.__wildfireLayer.group.visible)).toBe(true);
        await expect(page.locator('#wildfires-count')).toContainText('2');

        // Toggling off hides the group again.
        await setToggle(page, 'lyr-wildfires', false);
        await page.waitForFunction(
            () => !window.__wildfireLayer.group.visible, null, { timeout: 5_000 });
    });

    test('ground monitors load with attribution; species select refetches', async ({ page }) => {
        test.setTimeout(240_000);       // one earth.html boot under software GL
        // Species-aware mock: pm25 and o3 answer with distinct networks.
        await page.route('**/api/air-quality/stations-intl*', r => {
            const species = new URL(r.request().url()).searchParams.get('species') ?? 'pm25';
            const bodies = {
                pm25: {
                    species: 'pm25', label: 'PM2.5', unit: 'µg/m³',
                    stations: [
                        { id: '101:7', lat: 51.51, lon: -0.13, value: 34.2, utc: NOW_ISO() },
                        { id: '102:9', lat: 28.61, lon: 77.21, value: 96.5, utc: NOW_ISO() },
                        { id: '103:1', lat: -33.87, lon: 151.21, value: 4.1, utc: NOW_ISO() },
                    ],
                },
                o3: {
                    species: 'o3', label: 'O₃', unit: 'µg/m³',
                    stations: [
                        { id: '201:3', lat: 48.86, lon: 2.35, value: 88, utc: NOW_ISO() },
                        { id: '202:4', lat: 35.68, lon: 139.69, value: 122, utc: NOW_ISO() },
                    ],
                },
            };
            const b = bodies[species] ?? bodies.pm25;
            r.fulfill({
                json: {
                    updated: NOW_ISO(), count: b.stations.length, freshness: 'live',
                    configured: true, attribution: 'OpenAQ · CC BY 4.0', ...b,
                },
            });
        });
        await page.goto('/earth.html?verdict=0');
        await page.waitForFunction(() => window.__intlStationsLayer, null, { timeout: 60_000 });

        await expect(page.locator('#lyr-intl-stations')).not.toBeChecked();
        await page.check('#lyr-intl-stations');
        await page.waitForFunction(
            () => window.__intlStationsLayer.stations.length === 3, null, { timeout: 15_000 });
        expect(await page.evaluate(() => window.__intlStationsLayer.group.visible)).toBe(true);
        await expect(page.locator('#intl-stations-count')).toContainText('3');
        // CC BY attribution must survive into the pill title.
        await expect(page.locator('#intl-stations-count')).toHaveAttribute('title', /OpenAQ · CC BY 4.0/);

        // Species select drives a refetch of the O₃ parameter network.
        await page.selectOption('#intl-stations-species', 'o3');
        await page.waitForFunction(
            () => window.__intlStationsLayer.species === 'o3'
                && window.__intlStationsLayer.stations.length === 2
                && window.__intlStationsLayer.speciesLabel === 'O₃',
            null, { timeout: 15_000 });
        await expect(page.locator('#intl-stations-count')).toContainText('2');
    });

    test('residual layer pairs model with monitors and reports bias', async ({ page }) => {
        test.setTimeout(240_000);       // one earth.html boot under software GL
        await page.route('**/api/air-quality/residuals', r => r.fulfill({
            json: {
                updated: NOW_ISO(), count: 3, freshness: 'live', configured: true,
                species: 'pm25', unit: 'µg/m³', statsWeighting: 'station',
                attribution: 'OpenAQ · CC BY 4.0',
                stats: { bias: 4.2, rmse: 9.1, meanObs: 22.4, meanModel: 18.2, count: 3 },
                residuals: [
                    { id: '101:7', lat: 28.61, lon: 77.21, obs: 96, model: 80, residual: 16, utc: NOW_ISO() },
                    { id: '102:9', lat: 40.71, lon: -74.01, obs: 9, model: 13, residual: -4, utc: NOW_ISO() },
                    { id: '103:1', lat: 51.51, lon: -0.13, obs: 12, model: 11.4, residual: 0.6, utc: NOW_ISO() },
                ],
            },
        }));
        await page.goto('/earth.html?verdict=0');
        await page.waitForFunction(() => window.__residualLayer, null, { timeout: 60_000 });

        await expect(page.locator('#lyr-aq-residuals')).not.toBeChecked();
        await page.check('#lyr-aq-residuals');
        await page.waitForFunction(
            () => window.__residualLayer.rows.length === 3, null, { timeout: 15_000 });
        expect(await page.evaluate(() => window.__residualLayer.group.visible)).toBe(true);
        await expect(page.locator('#aq-residuals-count')).toContainText('bias +4.2');
        await expect(page.locator('#aq-residuals-count')).toHaveAttribute('title', /rmse 9.10/);
        await expect(page.locator('#aq-residuals-count')).toHaveAttribute('title', /CAMS underestimates/);

        await page.uncheck('#lyr-aq-residuals');
        expect(await page.evaluate(() => window.__residualLayer.group.visible)).toBe(false);
    });

    test('unconfigured OpenAQ key reads as setup, not error', async ({ page }) => {
        test.setTimeout(240_000);       // one earth.html boot under software GL
        await page.route('**/api/air-quality/stations-intl*', r => r.fulfill({
            json: {
                updated: NOW_ISO(), count: 0, freshness: 'stale', configured: false,
                reason: 'OPENAQ_API_KEY not configured — free key at explore.openaq.org/register',
                attribution: 'OpenAQ · CC BY 4.0', stations: [],
            },
        }));
        await page.goto('/earth.html?verdict=0');
        await page.waitForFunction(() => window.__intlStationsLayer, null, { timeout: 60_000 });
        await page.check('#lyr-intl-stations');
        await expect(page.locator('#intl-stations-count')).toContainText('needs key', { timeout: 15_000 });
        await expect(page.locator('#intl-stations-count')).toHaveAttribute('title', /OPENAQ_API_KEY/);
    });

    test('stale feed reads as an error, not a quiet empty layer', async ({ page }) => {
        await page.route('**/api/air-quality/centers', r => r.fulfill({
            json: { updated: NOW_ISO(), count: 0, freshness: 'stale', cities: [], worst: [], error: 'CAMS HTTP 503' },
        }));
        await page.goto('/earth.html?verdict=0');
        await page.waitForFunction(() => window.__pollutionCentersLayer, null, { timeout: 45_000 });

        await page.check('#lyr-pollution-centers');
        await expect(page.locator('#pollution-centers-count')).toContainText('error', { timeout: 15_000 });
        await expect(page.locator('#pollution-centers-count')).toHaveClass(/error/);
        expect(await page.evaluate(() => window.__pollutionCentersLayer.centers.length)).toBe(0);
    });
});
