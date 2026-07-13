/**
 * verdict-card-smoke.spec.js — smoke test for the EarthView verdict card
 * ═══════════════════════════════════════════════════════════════════════════
 * Boots earth.html in headless Chromium with a saved location pre-seeded and
 * the two Open-Meteo endpoints mocked (deterministic fixtures — CI has no
 * outbound network), then verifies the card's contract:
 *
 *   1. The card mounts at #verdict-host by default (no flag needed) and
 *      renders all sections: verdict word, 6 factor chips, temp graph,
 *      week grid, tonight's-sky rows, CTA + Explore, provenance.
 *   2. Factor chips carry real values from the mocked feed (not '--').
 *   3. Dragging the header by pointer moves the card and persists position.
 *   4. Explore › collapses to the pill; the pill restores the card.
 *   5. ?verdict=0 disables the card entirely (opt-out contract).
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

/** Open-Meteo air-quality fixture: 48 h of a fixed AQI. */
function aqFixture(nowMs) {
    const start = Math.floor(nowMs / HOUR) * HOUR;
    const time = [], us_aqi = [];
    for (let i = 0; i < 48; i++) {
        time.push((start + i * HOUR) / 1000);
        us_aqi.push(42);
    }
    return { hourly: { time, us_aqi } };
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

    test('?verdict=0 disables the card', async ({ page }) => {
        await bootWithCard(page, '/earth.html?verdict=0');
        // Give the lazy-init window time to (not) fire.
        await page.waitForTimeout(4_000);
        await expect(page.locator('#ev-verdict-card')).toHaveCount(0);
        // The host stays present-but-empty; the classic UI is untouched.
        await expect(page.locator('#loc-panel')).toBeAttached();
    });
});
