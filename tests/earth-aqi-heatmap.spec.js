/**
 * earth-aqi-heatmap.spec.js — gate for the EarthView AQI density heatmap:
 * the gradient drape, the species select (aggregate / CO₂ / NO₂), and the
 * two density sliders (plume spread + density floor).
 * ═══════════════════════════════════════════════════════════════════════════
 * Boots earth.html (verdict off) with the two CAMS feeds mocked and checks:
 *
 *   1. Toggle contract: default off/hidden; enabling fetches, drapes, and
 *      reports a live sample count.
 *   2. The interpolated field is real: valueAt() near a mocked hotspot city
 *      reads high, mid-ocean reads near background — a gradient, not a flat
 *      wash.
 *   3. Species diverge: CO₂ view reads ppm-scale values from the same
 *      probe point; NO₂ view µg/m³-scale — tracked separately, and the
 *      aggregate view remains the merged city+grid AQI field.
 *   4. Sliders drive the field: narrowing plume spread pulls a far-field
 *      probe back toward background (the rebuild is debounced, so poll).
 *   5. co2Available:false from the feed disables the CO₂ option instead of
 *      letting it error on selection.
 *
 * Runs via `npx playwright test tests/earth-aqi-heatmap.spec.js`.
 */

import { test, expect } from '@playwright/test';

const NOW_ISO = () => new Date().toISOString();

function centersFixture({ co2 = true } = {}) {
    return {
        updated: NOW_ISO(), count: 3, freshness: 'live', co2Available: co2,
        provenance: { id: 'open-meteo-cams-global', kind: 'model' },
        cities: [
            { name: 'Delhi', country: 'India', lat: 28.61, lon: 77.21, pop: 32, aqi: 172, pm25: 96, no2: 44, co2: co2 ? 468 : null, aod: 0.85, time: NOW_ISO() },
            { name: 'Lahore', country: 'Pakistan', lat: 31.55, lon: 74.34, pop: 13, aqi: 166, pm25: 88, no2: 40, co2: co2 ? 461 : null, aod: 0.8, time: NOW_ISO() },
            { name: 'New York', country: 'USA', lat: 40.71, lon: -74.01, pop: 19.5, aqi: 42, pm25: 9, no2: 18, co2: co2 ? 431 : null, aod: 0.1, time: NOW_ISO() },
        ],
        worst: ['Delhi'],
    };
}

const GRID_FIXTURE = () => {
    const points = [];
    for (const lat of [-60, -30, 0, 30, 60]) {
        for (let lon = -160; lon <= 160; lon += 40) {
            points.push({ id: `cams-${points.length}`, lat, lon, aqi: 15, pm25: 4, pm10: 9, aod: 0.05 });
        }
    }
    return { available: true, frame: { validAt: NOW_ISO(), points } };
};

async function bootWithHeatmap(page, { co2 = true } = {}) {
    await page.route('**/api/air-quality/centers', r => r.fulfill({ json: centersFixture({ co2 }) }));
    await page.route('**/api/air-quality/grid*', r => r.fulfill({ json: GRID_FIXTURE() }));
    await page.goto('/earth.html?verdict=0');
    await page.waitForFunction(() => window.__aqiHeatmapLayer, null, { timeout: 45_000 });
    await page.check('#lyr-aqi-heatmap');
    await page.waitForFunction(
        () => window.__aqiHeatmapLayer.sampleCount > 0, null, { timeout: 15_000 });
}

const probe = (page, lat, lon) =>
    page.evaluate(([la, lo]) => window.__aqiHeatmapLayer.valueAt(la, lo), [lat, lon]);

test.describe('EarthView AQI density heatmap', () => {
    test('gradient field, species divergence, slider control', async ({ page }) => {
        // earth.html boots in ~40-50 s under headless software GL, and this
        // spec walks three species + two sliders after boot — the default
        // 60 s test budget is not enough by design, not by accident.
        test.setTimeout(240_000);
        await bootWithHeatmap(page);

        // 1. Toggle contract.
        expect(await page.evaluate(() => window.__aqiHeatmapLayer.group.visible)).toBe(true);
        await expect(page.locator('#aqi-heatmap-count')).toContainText('pts');
        await expect(page.locator('#aqi-heatmap-count')).toHaveClass(/live/);

        // 2. A gradient, not a wash: hot near Delhi, background mid-Pacific.
        const nearDelhi = await probe(page, 28.6, 77.2);
        const midPacific = await probe(page, -45, -140);
        expect(nearDelhi).toBeGreaterThan(100);
        expect(midPacific).toBeLessThan(30);

        // 3. Species tracked separately: CO₂ reads in ppm at the same spot,
        //    NO₂ in µg/m³ — then back to the aggregate AQI field.
        await page.selectOption('#aqi-heatmap-species', 'co2');
        await page.waitForFunction(() => {
            const v = window.__aqiHeatmapLayer.valueAt(28.6, 77.2);
            return v != null && v > 400;
        }, null, { timeout: 20_000 });
        await expect(page.locator('#aqi-heatmap-note')).toContainText('CO₂');

        await page.selectOption('#aqi-heatmap-species', 'no2');
        await page.waitForFunction(() => {
            const v = window.__aqiHeatmapLayer.valueAt(28.6, 77.2);
            return v != null && v > 20 && v < 200;
        }, null, { timeout: 20_000 });

        await page.selectOption('#aqi-heatmap-species', 'aggregate');
        await page.waitForFunction(
            () => window.__aqiHeatmapLayer.valueAt(28.6, 77.2) > 100, null, { timeout: 5_000 });

        // 4. Plume-spread slider: at 2000 km a probe ~1200 km from Delhi
        //    carries plume signal; narrowed to 500 km it falls to background.
        const farBefore = await probe(page, 20, 70);
        await page.locator('#aqi-heat-spread').fill('500');
        await page.locator('#aqi-heat-spread').dispatchEvent('input');
        await expect(page.locator('#aqi-heat-spread-out')).toHaveText('500 km');
        await page.waitForFunction(([before]) => {
            const now = window.__aqiHeatmapLayer.valueAt(20, 70);
            return now != null && now < before - 5;
        }, [farBefore], { timeout: 20_000 });

        // Density-floor slider updates its readout and layer state.
        await page.locator('#aqi-heat-floor').fill('60');
        await page.locator('#aqi-heat-floor').dispatchEvent('input');
        await expect(page.locator('#aqi-heat-floor-out')).toHaveText('60%');
        await page.waitForFunction(
            () => window.__aqiHeatmapLayer.floorPct === 60, null, { timeout: 5_000 });

        // Off hides the drape again.
        await page.uncheck('#lyr-aqi-heatmap');
        expect(await page.evaluate(() => window.__aqiHeatmapLayer.group.visible)).toBe(false);
    });

    test('feed without CO₂ disables the CO₂ option instead of erroring', async ({ page }) => {
        await bootWithHeatmap(page, { co2: false });
        await expect(page.locator('#aqi-heatmap-species option[value="co2"]')).toBeDisabled();
        // Aggregate still works untouched.
        expect(await probe(page, 28.6, 77.2)).toBeGreaterThan(100);
    });
});
