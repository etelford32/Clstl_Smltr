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
        // Default: empty validation ledger (per-test routes override — LIFO).
        await page.route('**/api/cme/skill*', (r) => r.fulfill({
            json: { data: { models: [], events: [] } } }));
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
        // Both launches draw dots (the ED one highlighted). NOT asserted
        // per-day: a "12 h ago" launch falls on yesterday or today
        // depending on the wall clock (00:40Z flake, 2026-07-23).
        await expect(page.locator('.cal-dot')).toHaveCount(2);
        await expect(page.locator('.cal-dot.ed')).toHaveCount(1);
    });

    test('scorecard: quiet note, skill strip, predicted-vs-actual, false alarm, countdown', async ({ page }) => {
        test.slow();
        // Quiet corridor first: an empty grid must say so, and the empty
        // ledger arms honestly instead of showing fake numbers.
        await expect(page.locator('.cal-quiet')).toContainText('corridor is quiet');
        await expect(page.locator('.cal-skill-arming')).toContainText('ledger arming');

        // Now a populated ledger: two resolved events + one live skill row.
        const H = 3.6e6;
        const predA = Date.now() - 3 * DAY;                 // observed band
        const shockA = predA + 3 * H;                       // we were 3 h early
        const predB = Date.now() - 5 * DAY;                 // false alarm
        const hssEta = Date.now() + 4 * DAY;               // upcoming window
        const hssPast = Date.now() - 2 * DAY;              // scored stream
        await page.route('**/api/cme/skill*', (r) => r.fulfill({ json: { data: {
            models: [{ model_id: 'dbm-v1', is_hindcast: false, n_scored: 7,
                       mae_hours: 9.8, bias_hours: 2.1, hits_12h: 5,
                       false_alarms: 1, misses: 0 }],
            events: [
                { donki_id: 'CME-VAL', forecasts: { enlil: {
                    predicted: new Date(predA).toISOString() } },
                  truth: { arrived: true, shock: new Date(shockA).toISOString() } },
                { donki_id: 'CME-FAL', forecasts: { enlil: {
                    predicted: new Date(predB).toISOString() } },
                  truth: { arrived: false, shock: null } },
            ],
            // The SECOND weather: one upcoming corotation window + one
            // scored stream arrival (speed rise 5 h after our call).
            hss: {
                models: [{ model_id: 'corotation-v1', is_hindcast: false,
                    n_scored: 3, mae_hours: 11.2, bias_hours: -1.4,
                    hits_12h: 2, false_alarms: 1, misses: 0 }],
                events: [
                    { hole_id: 'HSS-NEXT-E30', stony_lon_deg: 30,
                      forecasts: { 'corotation-v1': {
                          predicted: new Date(hssEta).toISOString(),
                          window_start: new Date(hssEta - DAY).toISOString(),
                          window_end: new Date(hssEta + DAY).toISOString() } },
                      truth: null },
                    { hole_id: 'HSS-PAST-W20', stony_lon_deg: -20,
                      forecasts: { 'corotation-v1': {
                          predicted: new Date(hssPast).toISOString(),
                          window_start: new Date(hssPast - DAY).toISOString(),
                          window_end: new Date(hssPast + DAY).toISOString() } },
                      truth: { arrived: true, v_peak: 655,
                          arrival_at: new Date(hssPast + 5 * H).toISOString() } },
                ],
            },
        } } }));
        // The mount fetches the ledger once at boot — reload so the
        // populated route above is what the fresh boot sees.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#cme-calendar-host .cal-grid', { timeout: 30_000 });
        // Matching CMEs through the real bus (ids line up with donki_id),
        // plus one future arrival for the countdown chip.
        await page.evaluate(({ DAY, H }) => {
            const now = Date.now();
            const mk = (id, launchMs, arrMs) => ({
                time: new Date(launchMs).toISOString(), cme_id: id,
                speed: 800, halfAngle: 40, earthDirected: true,
                enlil: { shock_arrival: new Date(arrMs).toISOString(), kp_90: 5 } });
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: {
                recent_cmes: [
                    mk('CME-VAL', now - 3 * DAY - 40 * H, now - 3 * DAY),
                    mk('CME-FAL', now - 5 * DAY - 40 * H, now - 5 * DAY),
                    mk('CME-NEXT', now - 10 * H, now + 41 * H),
                ],
            } }));
        }, { DAY, H });

        // Resolved hit: struck-through prediction, bold actual, +/− error.
        // (:not(.hss) — the HSS scored chip shares the class family.)
        const scored = page.locator('.cal-ev.scored:not(.hss)');
        await expect(scored).toHaveCount(1, { timeout: 15_000 });
        await expect(scored.locator('s')).toBeVisible();
        await expect(scored.locator('.cal-err')).toHaveText('−3.0 h');
        await expect(scored).toHaveClass(/hit/);
        // False alarm: marked, never a fake arrival.
        await expect(page.locator('.cal-ev.falarm')).toContainText('no arrival');
        // Upcoming arrival carries the live countdown.
        await expect(page.locator('.cal-ev.next .cal-count')).toHaveText('in 41 h');
        // Skill strip: real numbers + the honesty line; quiet note gone.
        await expect(page.locator('.cal-skill-chip', { hasText: 'DBM' }))
            .toContainText('9.8 h');
        await expect(page.locator('.cal-skill-note')).toContainText('skill shown, not claimed');
        await expect(page.locator('.cal-quiet')).toHaveCount(0);

        // The SECOND weather on the same grid: an upcoming ◐ corotation
        // window, a SCORED stream (struck prediction → bold speed-rise
        // time with signed error), and its model row in the ONE strip.
        await expect(page.locator('.cal-ev.hss:not(.scored)')).toHaveCount(1, { timeout: 15_000 });
        const hssScored = page.locator('.cal-ev.hss.scored');
        await expect(hssScored).toHaveCount(1);
        // Rise came 5 h AFTER our call → we were early → −5.0 (house
        // convention: + = forecast late, same as the CME chips).
        await expect(hssScored.locator('.cal-err')).toHaveText('−5.0 h');
        await expect(page.locator('.cal-skill-chip', { hasText: 'Corotation' }))
            .toContainText('11.2 h');
        await expect(page.locator('.cal-skill-note')).toContainText('speed rise');

        // Data-plane honesty: a DEMO_KEY bus flag surfaces as the amber
        // config note (the "calendar seems broke" fix — starvation is
        // named, never mistaken for a quiet sun).
        await page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('swpc-update',
                { detail: { donki_key_mode: 'demo' } }));
        });
        await expect(page.locator('.cal-note-warn')).toContainText('DEMO_KEY');
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
