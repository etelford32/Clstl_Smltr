// cme-calendar.spec.js — browser gate for the CME arrival calendar on
// space-weather.html (js/cme-calendar.js). The pure grid/event math is
// node-gated by tests/cme-calendar.mjs; THIS pins the page wiring: the
// calendar renders from the 'swpc-update' bus, arrival chips carry the
// ENLIL-preferred times, and the τ link to the Stage works BOTH ways
// (chip click → __swStage.setTau; setTau → .cursor day highlight).
//
// Deliberately offline (the stage-spec pattern): external feeds are
// aborted and the calendar is fed a synthetic bus event.

import { test, expect } from '@playwright/test';

const DAY = 86_400e3;

test.describe('CME arrival calendar on space-weather.html', () => {

    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('pp_auth', JSON.stringify({
                signedIn: true, id: 'e2e-cal', email: 'e2e@playwright.test',
                plan: 'free', role: 'user', provider: 'password',
            }));
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch {}
        });
        await page.route('**/services.swpc.noaa.gov/**', (r) => r.abort());
        await page.route('**/api/nasa/**', (r) => r.abort());
        await page.route('**/api/donki/**', (r) => r.abort());
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#cme-calendar-host .cal-grid', { timeout: 30_000 });
    });

    test('renders the −7…+30 grid and places bus-fed events honestly', async ({ page }) => {
        // 38 day cells (+ lead blanks), 7 observed, one today.
        const days = page.locator('.cal-day:not(.blank)');
        await expect(days).toHaveCount(38);
        await expect(page.locator('.cal-day.past')).toHaveCount(7);
        await expect(page.locator('.cal-day.today')).toHaveCount(1);

        // Feed one Earth-directed CME with an ENLIL arrival in 2 days and
        // one non-Earth-directed launch 2 days ago through the REAL bus.
        await page.evaluate(({ DAY }) => {
            const now = Date.now();
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: {
                kp: 3, solar_wind: { speed: 450 },
                recent_cmes: [
                    { time: new Date(now - 12 * 3.6e6).toISOString(),
                      cme_id: 'E2E-CME-1', speed: 900, halfAngle: 45,
                      latitude: 4, longitude: -8, earthDirected: true,
                      enlil: { shock_arrival: new Date(now + 2 * DAY).toISOString(),
                               kp_90: 6, kp_135: 5, kp_180: 4 } },
                    { time: new Date(now - 2 * DAY).toISOString(),
                      cme_id: 'E2E-CME-2', speed: 600, halfAngle: 30,
                      latitude: 40, longitude: 120, earthDirected: false },
                ],
            } }));
        }, { DAY });

        // ⊕ arrival chip on the +2 d day, G2 from the ENLIL Kp 6.
        const chip = page.locator('.cal-ev');
        await expect(chip).toHaveCount(1);
        await expect(chip).toHaveClass(/g2/);
        await expect(chip).toContainText('⊕');
        // The non-Earth-directed CME is a launch dot in the observed band.
        await expect(page.locator('.cal-day.past .cal-dot')).toHaveCount(1);
        // Earth-directed launch dot is highlighted.
        await expect(page.locator('.cal-dot.ed')).toHaveCount(1);
    });

    test('τ link both ways: chip click sets Stage τ; setTau moves the day cursor', async ({ page }) => {
        test.slow();
        // The Stage must be up for the τ contract.
        await page.waitForSelector('#sw-stage-host canvas', { timeout: 30_000 });
        await expect.poll(() => page.evaluate(() => !!window.__swStage)).toBe(true);

        const arrivalMs = await page.evaluate(({ DAY }) => {
            const t = Date.now() + 5 * DAY;
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: {
                recent_cmes: [{ time: new Date(Date.now() - DAY).toISOString(),
                    cme_id: 'E2E-CME-TAU', speed: 700, halfAngle: 40,
                    earthDirected: true,
                    enlil: { shock_arrival: new Date(t).toISOString(), kp_90: 5 } }],
            } }));
            return t;
        }, { DAY });

        // Calendar → Stage: clicking the arrival chip scrubs τ to it.
        await page.locator('.cal-ev').click();
        await expect.poll(() => page.evaluate(() => window.__swStage.tauMs))
            .toBe(arrivalMs);
        // …and the Stage's own sw-tau dispatch moved the cursor here.
        await expect(page.locator('.cal-day.cursor')).toHaveCount(1);

        // Stage → calendar: an external scrub highlights the right day.
        await page.evaluate(({ DAY }) =>
            window.__swStage.setTau(Date.now() + 10 * DAY), { DAY });
        const cursor = page.locator('.cal-day.cursor');
        await expect(cursor).toHaveCount(1);
        const dayMs = await cursor.getAttribute('data-day');
        const expected = await page.evaluate(({ DAY }) =>
            Math.floor((Date.now() + 10 * DAY) / DAY) * DAY, { DAY });
        expect(Math.abs(+dayMs - expected)).toBeLessThanOrEqual(DAY);
    });
});
