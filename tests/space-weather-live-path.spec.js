// space-weather-live-path.spec.js — the END-TO-END live-forecast path on
// space-weather.html. Every other spec mocks or aborts the provider; this
// one feeds FAITHFUL fixtures through the real edges — the exact response
// shape api/donki/cme.js emits and the exact NOAA rtsw_*_1m.json row
// shape — and lets the ACTUAL pipeline run: fetchDonkiCmes → donkiToPreset
// → committed WASM → 500-member ensemble → particle filter → panel render
// → 'flux-rope-forecast' publish → Stage rope + status band consume it.
// This is the test that was missing when the deployed panel broke.

import { test, expect } from '@playwright/test';

const H = 3.6e6;

function fixtures(nowMs) {
    const launch = new Date(nowMs - 36 * H).toISOString().slice(0, 16) + 'Z';
    const pastLaunch = new Date(nowMs - 5 * 24 * H).toISOString().slice(0, 16) + 'Z';
    const donki = { data: { cmes: [{
        cme_id: 'CME-e2e-001', time: launch, most_accurate: true,
        speed_km_s: 800, latitude_deg: 5, longitude_deg: -10,
        half_angle_deg: 40, earth_directed: true, note: 'e2e fixture',
    }, {
        // A PAST Earth-directed event for the calendar-replay test —
        // listed second so the LIVE run still targets the recent one.
        cme_id: 'CME-e2e-PAST', time: pastLaunch, most_accurate: true,
        speed_km_s: 900, latitude_deg: -4, longitude_deg: 12,
        half_angle_deg: 45, earth_directed: true, note: 'e2e past fixture',
        enlil: { shock_arrival: new Date(nowMs - 4 * 24 * H).toISOString(), kp_90: 6 },
    }] } };
    const mag = [], wind = [];
    for (let i = 24 * 12; i >= 0; i--) {   // last 24 h, 5-min cadence
        const t = new Date(nowMs - i * 5 * 60e3).toISOString().slice(0, 19);
        mag.push({ time_tag: t, bx_gsm: 1.2, by_gsm: -2.0,
                   bz_gsm: +(3 * Math.sin(i / 9)).toFixed(2) });
        wind.push({ time_tag: t, proton_speed: 420, proton_density: 5.1 });
    }
    return { donki, mag, wind };
}

test.describe('live forecast path (faithful fixtures, real pipeline)', () => {

    test('DONKI → WASM ensemble → panel + Stage rope + band outlook', async ({ page }) => {
        test.slow();
        const { donki, mag, wind } = fixtures(Date.now());
        await page.addInitScript(() => {
            localStorage.setItem('pp_auth', JSON.stringify({
                signedIn: true, id: 'e2e-live', email: 'e2e@playwright.test',
                plan: 'free', role: 'user', provider: 'password',
            }));
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch {}
        });
        await page.route('**/api/donki/cme*', (r) => r.fulfill({ json: donki }));
        await page.route('**/rtsw/rtsw_mag_1m.json', (r) => r.fulfill({ json: mag }));
        await page.route('**/rtsw/rtsw_wind_1m.json', (r) => r.fulfill({ json: wind }));
        const panelErrors = [];
        page.on('console', (m) => {
            if (/flux-rope dashboard panel unavailable/.test(m.text())) panelErrors.push(m.text());
        });
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });

        // The panel must reach its RENDERED state — chart canvas + stats —
        // never the hidden/failed state.
        const panel = page.locator('#flux-rope-forecast-panel');
        await expect(panel.locator('.frd-chart')).toBeVisible({ timeout: 60_000 });
        await expect(panel).toContainText('P(Earth hit)');
        await expect(panel).toContainText('ensemble');
        expect(panelErrors, panelErrors.join('\n')).toHaveLength(0);

        // The ONE provider run was published…
        const fc = await page.evaluate(() => ({
            has: !!window.__fluxRopeForecast, idle: window.__fluxRopeForecast?.idle,
            pHit: window.__fluxRopeForecast?.summary?.pHit,
        }));
        expect(fc.has).toBe(true);
        expect(fc.idle).toBe(false);
        expect(fc.pHit).toBeGreaterThan(0);

        // …and both downstream consumers show it: the Stage draws the rope
        // (apex mid-corridor 36 h after an 800 km/s launch)…
        await expect.poll(() => page.evaluate(() => window.__swStage?.forecastState),
            { timeout: 30_000 }).toBe('live');
        await expect.poll(() => page.evaluate(() => window.__swStage?.ropeVisible),
            { timeout: 30_000 }).toBe(true);
        // …the particle cloud binds to the ensemble (S5b): members baked,
        // sheath compression ≥ 1 from the R–H oracle.
        await expect.poll(() => page.evaluate(() => window.__swStage?.particles?.cmeActive),
            { timeout: 30_000 }).toBe(true);
        const cloud = await page.evaluate(() => window.__swStage.particles);
        expect(cloud.members).toBeGreaterThan(0);
        expect(cloud.comp).toBeGreaterThanOrEqual(1);
        // …and the status band's outlook cell leaves 'Quiet'.
        await expect(page.locator('#sw-status-band [data-cell="outlook"] .swb-value'))
            .not.toHaveText('Quiet', { timeout: 30_000 });
    });

    test('calendar replay: clicking a past event re-seeds the whole page', async ({ page }) => {
        test.slow();
        const { donki, mag, wind } = fixtures(Date.now());
        await page.addInitScript(() => {
            localStorage.setItem('pp_auth', JSON.stringify({
                signedIn: true, id: 'e2e-replay', email: 'e2e@playwright.test',
                plan: 'free', role: 'user', provider: 'password',
            }));
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch {}
        });
        await page.route('**/api/donki/cme*', (r) => r.fulfill({ json: donki }));
        await page.route('**/rtsw/rtsw_mag_1m.json', (r) => r.fulfill({ json: mag }));
        await page.route('**/rtsw/rtsw_wind_1m.json', (r) => r.fulfill({ json: wind }));
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });

        // Live run publishes first: no replay stamp, and it targets the
        // RECENT event (36 h-old launch), not the past one.
        await page.waitForFunction(() => window.__fluxRopeForecast?.idle === false,
            null, { timeout: 90_000 });
        const live0 = await page.evaluate(() => ({
            replay: window.__fluxRopeForecast.replay ?? null,
            launchMs: window.__fluxRopeForecast.launchMs,
        }));
        expect(live0.replay).toBe(null);
        expect(Date.now() - live0.launchMs).toBeLessThan(48 * 3.6e6);

        // …then clicking the PAST event's calendar chip re-runs the ONE
        // provider seeded with it: replay stamped, Stage rope shows the
        // event at its own transit, band cells relabel, chip scrubbed τ.
        const chip = page.locator('.cal-ev[data-cme-id="CME-e2e-PAST"]');
        await expect(chip).toBeVisible({ timeout: 30_000 });
        await chip.click();
        await expect.poll(() => page.evaluate(
            () => window.__fluxRopeForecast?.replay?.id ?? null),
            { timeout: 90_000 }).toBe('CME-e2e-PAST');
        await expect.poll(() => page.evaluate(() => window.__swStage?.ropeVisible),
            { timeout: 30_000 }).toBe(true);
        await expect(page.locator('#sw-status-band [data-cell="outlook"] .swb-label'))
            .toContainText('REPLAY', { timeout: 15_000 });
        await expect(page.locator('#sw-stage-host .swst-chip', { hasText: 'REPLAY' }))
            .toBeVisible();
        // τ was scrubbed to the event's arrival (a past instant).
        expect(await page.evaluate(() => window.__swStage.tauMs)).toBeLessThan(Date.now());

        // Exit via the panel link → the live watch returns.
        await page.locator('.frd-exit-replay').click();
        await expect.poll(() => page.evaluate(
            () => window.__fluxRopeForecast?.replay ?? null),
            { timeout: 90_000 }).toBe(null);
    });

    test('NOAA-blocked client falls back to the same-origin mirror', async ({ page }) => {
        test.slow();
        // The outage class from the field: the client network blocks
        // services.swpc.noaa.gov outright. Every direct fetch dies; the
        // /api/noaa/passthrough mirror serves the byte-identical product.
        const kpRows = [];
        for (let i = 60; i >= 0; i--) {
            kpRows.push({ time_tag: new Date(Date.now() - i * 60e3).toISOString().slice(0, 19),
                          kp_index: 4, estimated_kp: 4.33, kp: '4M' });
        }
        await page.addInitScript(() => {
            localStorage.setItem('pp_auth', JSON.stringify({
                signedIn: true, id: 'e2e-mirror', email: 'e2e@playwright.test',
                plan: 'free', role: 'user', provider: 'password',
            }));
        });
        await page.route('**/services.swpc.noaa.gov/**', (r) => r.abort());
        await page.route('**/api/noaa/passthrough*', (r) => {
            const path = new URL(r.request().url()).searchParams.get('path');
            if (path === 'json/planetary_k_index_1m.json') {
                return r.fulfill({ json: kpRows });
            }
            return r.fulfill({ status: 502, json: { error: 'upstream' } });
        });
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });
        // Kp reaches the page through the mirror: the band's Kp cell gets
        // a real value instead of the dead 0.0 / '—'.
        await expect.poll(async () =>
            (await page.locator('#sw-status-band [data-cell="kp"] .swb-value').textContent())?.trim(),
            { timeout: 60_000 }).toMatch(/^4(\.3)?/);
    });
});
