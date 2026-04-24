/**
 * space-weather-ua-smoke.spec.js — Upper Atmosphere card smoke test
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies the card embedded in space-weather.html:
 *   1. Renders the five value rows + mini-plot canvas.
 *   2. Populates from whatever Kp is already in #kp-val.
 *   3. Re-renders when #kp-val mutates (the MutationObserver path).
 *   4. Mini-plot canvas draws at least one non-transparent pixel.
 */

import { test, expect } from '@playwright/test';

const URL = '/space-weather.html';
const BOOT_TIMEOUT_MS = 20_000;

function attachConsoleRecorder(page) {
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));
    return errors;
}

async function waitForCard(page) {
    await page.waitForSelector('#ua-card', { timeout: BOOT_TIMEOUT_MS });
    // Wait for the value rows to be populated by the inline module
    // script. The engine import + first paint should resolve synchronously
    // after module fetch; give the network 4 s to be safe.
    await page.waitForFunction(() => {
        const t = document.getElementById('ua-rho-iss')?.textContent?.trim();
        return !!t && t !== '–';
    }, { timeout: BOOT_TIMEOUT_MS });
}

test.describe('space-weather upper-atmosphere card', () => {

    test('renders all value rows + mini plot canvas', async ({ page }) => {
        await page.goto(URL);
        await waitForCard(page);

        for (const id of ['ua-rho-iss', 'ua-rho-600', 'ua-tinf',
                          'ua-dom', 'ua-regime']) {
            const text = (await page.textContent(`#${id}`))?.trim();
            expect(text, `${id} populated`).toBeTruthy();
            expect(text, `${id} not placeholder`).not.toBe('–');
        }

        // Canvas present and sized.
        const rect = await page.locator('#ua-mini-plot').boundingBox();
        expect(rect?.width, 'mini-plot has width').toBeGreaterThan(50);
        expect(rect?.height, 'mini-plot has height').toBeGreaterThan(50);
    });

    test('recomputes when Kp changes (MutationObserver path)', async ({ page }) => {
        await page.goto(URL);
        await waitForCard(page);
        const before = await page.textContent('#ua-rho-iss');

        // Simulate a geomagnetic storm — Kp 7 → Ap 140 (SWPC table).
        // The card's MutationObserver should fire on the textContent change.
        await page.evaluate(() => {
            const el = document.getElementById('kp-val');
            if (el) el.textContent = '7';
        });
        await page.waitForTimeout(400);
        const after = await page.textContent('#ua-rho-iss');

        expect(after, 'rho value changed after Kp update').not.toBe(before);

        // ρ @ ISS should increase during a storm — compare exponents.
        const expOf = (s) => {
            const m = s?.match(/([0-9.+-]+)e([+-]?\d+)/i);
            return m ? parseFloat(m[2]) : -30;
        };
        expect(expOf(after),
            `storm ρ@ISS should be ≥ quiet ρ@ISS (before=${before}, after=${after})`)
            .toBeGreaterThanOrEqual(expOf(before));
    });

    test('mini plot actually drew pixels', async ({ page }) => {
        await page.goto(URL);
        await waitForCard(page);
        // Sample pixels from the canvas; at least one should be non-transparent.
        const hasContent = await page.evaluate(() => {
            const c = document.getElementById('ua-mini-plot');
            if (!c) return false;
            const ctx = c.getContext('2d');
            // The draw routine paints a background gradient + curve — any
            // non-zero alpha pixel counts.
            const w = c.width, h = c.height;
            const data = ctx.getImageData(0, 0, w, h).data;
            for (let i = 3; i < data.length; i += 4) {
                if (data[i] !== 0) return true;
            }
            return false;
        });
        expect(hasContent, 'mini-plot has non-transparent pixels').toBe(true);
    });

    test('boots without console errors relevant to the UA card', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(URL);
        await waitForCard(page);
        await page.waitForTimeout(2_000);

        // Filter noise: CDN 503s for blue-marble texture, third-party
        // feed failures (NOAA endpoints can 429) are not our concern here.
        const ours = errors.filter(msg =>
            /upper-atmosphere|getSnapshot|ua-|density\(/i.test(msg)
        );
        if (ours.length) console.error('UA-card console errors:', ours);
        expect(ours, 'no UA-card-originated console errors').toHaveLength(0);
    });
});
