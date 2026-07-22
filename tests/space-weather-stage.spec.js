// space-weather-stage.spec.js — browser gate for THE STAGE (S1):
// js/stage/stage.js on space-weather.html. The pure model + scale math is
// node-gated (tests/stage-{scale,model}.mjs, kernel-oracle pinned); THIS
// pins that the scene actually boots in-page: WebGL context comes up,
// stations 1–4 render and switch, the τ-timeline scrubs and dispatches
// the 'sw-tau' contract, the true-scale toggle animates the compression
// away, and the HTML overlay annotations exist (never canvas-rasterized).
//
// Deliberately offline: external feeds are aborted — the Stage must show
// the quiet corridor without a forecast. Assertions avoid frame-rate
// dependence (software-GL CI lesson).

import { test, expect } from '@playwright/test';

const ENV_NOISE = /Failed to load resource|ERR_TUNNEL|ERR_FAILED|ERR_NAME|Supabase|dynamically imported module|501|404|429/;

test.describe('the Stage (S1) on space-weather.html', () => {
    let errors;

    test.beforeEach(async ({ page }) => {
        errors = [];
        page.on('console', (m) => {
            if (m.type() === 'error' && !ENV_NOISE.test(m.text())) errors.push(m.text());
        });
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.addInitScript(() => {
            localStorage.setItem('pp_auth', JSON.stringify({
                signedIn: true, id: 'e2e-stage', email: 'e2e@playwright.test',
                plan: 'free', role: 'user', provider: 'password',
            }));
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch {}
            // Record every sw-tau dispatch for the contract assertion.
            window.__tauEvents = [];
            window.addEventListener('sw-tau', (e) => window.__tauEvents.push(e.detail));
        });
        // Offline: the quiet corridor must not need any live feed.
        await page.route('**/services.swpc.noaa.gov/**', (r) => r.abort());
        await page.route('**/api/nasa/**', (r) => r.abort());
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });
    });

    test('boots: canvas, four stations, overlay annotations, quiet corridor', async ({ page }) => {
        const host = page.locator('#sw-stage-host');
        await expect(host.locator('canvas')).toBeVisible({ timeout: 30_000 });
        await expect(host.locator('.swst-stations button')).toHaveCount(4);
        // HTML overlay layer (never rasterized): body labels + AU ruler.
        await expect(host.locator('.swst-overlay')).toContainText('SUN');
        await expect(host.locator('.swst-overlay')).toContainText('EARTH');
        await expect(host.locator('.swst-overlay')).toContainText('1 AU');
        // Scale honesty is on-stage, in words.
        await expect(host.locator('.swst-disclose')).toContainText('compressed');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('stations switch with bounded orbit; flights land', async ({ page }) => {
        const host = page.locator('#sw-stage-host');
        await expect(host.locator('.swst-stations button')).toHaveCount(4, { timeout: 30_000 });
        await host.locator('.swst-stations button', { hasText: 'L1 Approach' }).click();
        await expect(host.locator('.swst-stations button.active')).toHaveText('L1 Approach');
        await expect.poll(() => page.evaluate(() => window.__swStage?.station))
            .toBe('l1-approach');
        await host.locator('.swst-stations button', { hasText: 'Magnetosphere' }).click();
        await expect.poll(() => page.evaluate(() => window.__swStage?.station))
            .toBe('magnetosphere');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('τ-timeline scrubs, labels the regime, and dispatches sw-tau', async ({ page }) => {
        const host = page.locator('#sw-stage-host');
        const slider = host.locator('input[type=range]');
        await expect(slider).toBeVisible({ timeout: 30_000 });
        await expect(host.locator('.swst-regime')).toHaveText('LIVE');

        await slider.fill('1000');           // scrub to +72 h
        await expect(host.locator('.swst-regime')).toHaveText('FORECAST');
        const fwd = await page.evaluate(() => window.__swStage.tauMs - Date.now());
        expect(fwd).toBeGreaterThan(70 * 3.6e6);

        await slider.fill('0');              // scrub to −24 h
        await expect(host.locator('.swst-regime')).toHaveText('REPLAY');

        await host.locator('.swst-now').click();
        await expect(host.locator('.swst-regime')).toHaveText('LIVE');

        // The dock contract: dispatches carry {tauMs, regime}.
        const events = await page.evaluate(() => window.__tauEvents);
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => Number.isFinite(e.tauMs) &&
            ['replay', 'live', 'forecast'].includes(e.regime))).toBe(true);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('true-scale toggle animates the compression away and back', async ({ page }) => {
        const host = page.locator('#sw-stage-host');
        const btn = host.locator('.swst-truescale');
        await expect(btn).toBeVisible({ timeout: 30_000 });
        expect(await page.evaluate(() => window.__swStage.mix)).toBeLessThan(0.01);
        await btn.click();
        await expect(btn).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => page.evaluate(() => window.__swStage.mix),
            { timeout: 10_000 }).toBeGreaterThan(0.9);
        await btn.click();
        await expect.poll(() => page.evaluate(() => window.__swStage.mix),
            { timeout: 10_000 }).toBeLessThan(0.1);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });
});
