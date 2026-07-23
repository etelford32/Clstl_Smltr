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

    test('boots: canvas, six stations, overlay annotations, quiet corridor', async ({ page }) => {
        const host = page.locator('#sw-stage-host');
        await expect(host.locator('canvas')).toBeVisible({ timeout: 30_000 });
        await expect(host.locator('.swst-stations button')).toHaveCount(6);
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
        await expect(host.locator('.swst-stations button')).toHaveCount(6, { timeout: 30_000 });
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

    test('S2: pin + My Sky staging + oval band from injected Kp', async ({ page }) => {
        // Seed a Fairbanks pin through the shared store the Stage reads.
        await page.addInitScript(() => {
            localStorage.setItem('ppx_user_location', JSON.stringify(
                { lat: 64.84, lon: -147.72, city: 'Fairbanks' }));
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        const host = page.locator('#sw-stage-host');
        await expect(host.locator('.swst-stations button')).toHaveCount(6, { timeout: 30_000 });

        // Inject Kp through the page bus → the oval band appears and the
        // pin label carries the drive-ring annotation.
        await page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: { kp: 6 } }));
        });
        await expect.poll(() => page.evaluate(() => window.__swStage?.ovalVisible),
            { timeout: 15_000 }).toBe(true);
        await expect.poll(() => page.evaluate(() => window.__swStage?.pinVisible)).toBe(true);
        await expect(host.locator('.swst-pin-label')).toContainText('Fairbanks');
        await expect(host.locator('.swst-pin-label')).toContainText(/oval/);

        // My Sky flight lands at the pin (ground-level: camera well inside
        // the Earth-local neighbourhood).
        await host.locator('.swst-stations button', { hasText: 'My Sky' }).click();
        await expect.poll(() => page.evaluate(() => window.__swStage?.station))
            .toBe('my-sky');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('S2: Orbit Ops — asset picker (mocked catalog), heat-shell chip, sw-pick', async ({ page }) => {
        const ISS = {
            name: 'ISS (ZARYA)', norad_id: 25544,
            line1: '1 25544U 98067A   26203.50000000  .00016717  00000-0  10270-3 0  9000',
            line2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
            epoch: '2026-07-22T12:00:00.000Z',
            inclination: 51.6416, period_min: 91.6, apogee_km: 424, perigee_km: 415,
        };
        await page.route('**/api/celestrak/tle*', (r) => r.fulfill({ json: [ISS] }));
        await page.addInitScript(() => {
            window.__picks = [];
            window.addEventListener('sw-pick', (e) => window.__picks.push(e.detail));
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        const host = page.locator('#sw-stage-host');
        await expect(host.locator('.swst-stations button')).toHaveCount(6, { timeout: 30_000 });

        // The picker opens with the Orbit Ops staging.
        await expect(host.locator('.swst-assets')).not.toBeVisible();
        await host.locator('.swst-stations button', { hasText: 'Orbit Ops' }).click();
        await expect(host.locator('.swst-assets')).toBeVisible();

        // NORAD search against the mocked catalog → add → persisted.
        await host.locator('.swst-assets input').fill('25544');
        await host.locator('.swst-asset-go').click();
        await expect(host.locator('.swst-asset-results .swst-asset-row')).toHaveCount(1);
        await host.locator('.swst-asset-results button').click();
        await expect(host.locator('.swst-asset-list .swst-asset-row')).toContainText('ISS');
        expect(await page.evaluate(() => window.__swStage.assets)).toEqual([25544]);
        expect(await page.evaluate(() =>
            JSON.parse(localStorage.getItem('sw-stage-assets')).length)).toBe(1);

        // The live dot + label exist and the drag heat-shell chip appears
        // once Kp is known (UA-engine oracle drives the color/ratio).
        await page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: { kp: 5 } }));
        });
        await expect(host.locator('.swst-asset-label')).toContainText('ISS');
        await expect.poll(async () =>
            (await host.locator('.swst-chip', { hasText: 'drag shell' }).count()))
            .toBeGreaterThan(0);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('S5a: particle stream flows at the disclosed lapse; true scale stills it; My Sky hides it', async ({ page }) => {
        test.slow();
        const host = page.locator('#sw-stage-host');
        await expect(host.locator('canvas')).toBeVisible({ timeout: 30_000 });
        const probe = () => page.evaluate(() => ({
            p: window.__swStage.particles,
            lost: getComputedStyle(
                document.querySelector('#sw-stage-host .swst-lost')).display !== 'none',
        }));
        const s0 = await probe();
        expect(s0.p.count).toBeGreaterThanOrEqual(4000);
        expect(s0.p.timeLapse).toBe(3600);
        expect(s0.p.visible).toBe(true);
        // The dishonesty is disclosed on-stage, in words.
        await expect(host.locator('.swst-disclose')).toContainText('×3600');

        // The flow advances under the wall-clock time-lapse. (Context
        // loss under software GL halts rendering honestly — skip, as in
        // the true-scale test.)
        const phase0 = s0.p.phase;
        await expect.poll(async () => {
            const s = await probe();
            test.skip(s.lost, 'WebGL context lost — honest fallback shown');
            return Math.abs(s.p.phase - phase0);
        }, { timeout: 20_000 }).toBeGreaterThan(1e-4);

        // True scale blends the lapse to ×1 — removability is the honesty.
        await host.locator('.swst-truescale').click();
        await expect.poll(async () => (await probe()).p.timeLapse,
            { timeout: 15_000 }).toBeLessThan(2);

        // My Sky is a ground-level sky view: the heliospheric cloud hides.
        await host.locator('.swst-stations button', { hasText: 'My Sky' }).click();
        await expect.poll(async () => (await probe()).p.visible).toBe(false);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('true-scale toggle animates the compression away and back', async ({ page }) => {
        // The tween is wall-clock-anchored (lands in 800 ms at ANY frame
        // rate), but if software-GL CI loses the WebGL context outright,
        // the render loop honestly halts behind the fallback overlay —
        // that environmental state is a SKIP, not a failure.
        test.slow();
        const host = page.locator('#sw-stage-host');
        const btn = host.locator('.swst-truescale');
        await expect(btn).toBeVisible({ timeout: 30_000 });
        const probe = () => page.evaluate(() => ({
            lost: getComputedStyle(
                document.querySelector('#sw-stage-host .swst-lost')).display !== 'none',
            mix: window.__swStage.mix,
        }));
        expect((await probe()).mix).toBeLessThan(0.01);
        await btn.click();
        await expect(btn).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(async () => {
            const s = await probe();
            test.skip(s.lost, 'WebGL context lost — the Stage shows its honest fallback');
            return s.mix;
        }, { timeout: 30_000 }).toBeGreaterThan(0.9);
        await btn.click();
        await expect.poll(async () => (await probe()).mix,
            { timeout: 30_000 }).toBeLessThan(0.1);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });
});
