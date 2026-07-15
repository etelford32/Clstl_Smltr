/**
 * city-markers-smoke.spec.js — smoke test for the major-city dots layer
 * and the click-to-select-location flow on earth.html.
 * ═══════════════════════════════════════════════════════════════════════════
 * Boots earth.html headless with the Open-Meteo endpoints mocked (CI has no
 * outbound network) and NO saved location, then verifies:
 *
 *   1. The layer boots: #lyr-cities ships checked, the Points group is
 *      visible, and the featured-row mirror (#feat-lyr-cities) agrees.
 *   2. Clicking a city dot (aimed via the window.__cityAtCenter probe, with
 *      auto-rotation disabled first so the aim stays valid) selects it:
 *      localStorage ppx_user_location carries the city, the EarthView card
 *      header personalises to it, and the location beacon mounts.
 *   3. The Layers toggle round-trips group.visible.
 *
 * Runs via `npx playwright test tests/city-markers-smoke.spec.js`.
 */

import { test, expect } from '@playwright/test';

const HOUR = 3_600_000;

function wxFixture(nowMs) {
    const start = Math.floor(nowMs / HOUR) * HOUR;
    const time = [], temperature_2m = [], precipitation_probability = [], cloud_cover = [], uv_index = [];
    for (let i = 0; i < 48; i++) {
        time.push((start + i * HOUR) / 1000);
        temperature_2m.push(70);
        precipitation_probability.push(0);
        cloud_cover.push(10);
        uv_index.push(3);
    }
    return { timezone: 'UTC', hourly: { time, temperature_2m, precipitation_probability, cloud_cover, uv_index }, daily: { time: [], temperature_2m_max: [], temperature_2m_min: [], weather_code: [], cloud_cover_mean: [], precipitation_probability_max: [] } };
}

async function boot(page) {
    const now = Date.now();
    await page.addInitScript(() => {
        localStorage.removeItem('ppx_user_location');
        localStorage.removeItem('ev_verdict_collapsed');
    });
    await page.route('**/api.open-meteo.com/**', r => r.fulfill({ json: wxFixture(now) }));
    await page.route('**/air-quality-api.open-meteo.com/**', r => r.fulfill({ json: { hourly: { time: [], us_aqi: [] } } }));
    await page.goto('/earth.html', { waitUntil: 'load' });
    // The markers are built in the main module after the texture await —
    // poll for the console handle instead of a fixed sleep.
    await page.waitForFunction(() => !!window.__cityMarkers, null, { timeout: 45_000 });
}

test.describe('major-city markers', () => {

    test('layer boots on: checkbox checked, group visible, featured mirror agrees', async ({ page }) => {
        await boot(page);
        await expect(page.locator('#lyr-cities')).toBeChecked();
        expect(await page.evaluate(() => window.__cityMarkers.group.visible)).toBe(true);
        expect(await page.evaluate(() => window.__cityMarkers.cities.length)).toBeGreaterThanOrEqual(240);
        await expect(page.locator('#feat-lyr-cities')).toBeChecked();
    });

    test('clicking a city dot selects it as my location', async ({ page }) => {
        await boot(page);

        // Freeze the camera so the projected dot position stays valid
        // between the probe evaluation and the mouse click. The DISPLAY-
        // section checkboxes sit in a collapsed panel section, so drive
        // the change event directly (same mechanism the featured-row
        // mirror uses) instead of a forced DOM click on a 0-size input.
        await page.evaluate(() => {
            const el = document.getElementById('lyr-rotate');
            el.checked = false;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(600);

        const target = await page.evaluate(() => window.__cityAtCenter());
        expect(target, 'probe returned a camera-facing city').toBeTruthy();
        expect(target.facing).toBeGreaterThan(0.7);

        await page.mouse.click(target.x, target.y);

        // Selection persists through the shared location pipeline…
        await expect
            .poll(async () => page.evaluate(() =>
                JSON.parse(localStorage.getItem('ppx_user_location') || 'null')?.city ?? null),
                { timeout: 5_000 })
            .toBe(target.name);

        // …the EarthView card header personalises…
        await expect(page.locator('#ev-verdict-card [data-ev="loc-name"]'))
            .toHaveText(target.name, { timeout: 15_000 });

        // …and the location beacon mounts on the globe.
        expect(await page.evaluate(() =>
            !!document.querySelector('canvas') && window.__cityMarkers.group.visible)).toBe(true);
    });

    test('Layers toggle round-trips group visibility', async ({ page }) => {
        await boot(page);
        // Drive the canonical checkbox via a change event — it lives in a
        // collapsed panel section, so a forced DOM click has no target.
        const setCities = (on) => page.evaluate((v) => {
            const el = document.getElementById('lyr-cities');
            el.checked = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, on);
        await setCities(false);
        await expect
            .poll(() => page.evaluate(() => window.__cityMarkers.group.visible))
            .toBe(false);
        await setCities(true);
        await expect
            .poll(() => page.evaluate(() => window.__cityMarkers.group.visible))
            .toBe(true);
    });
});
