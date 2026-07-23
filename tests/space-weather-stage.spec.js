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
        // S7: block the SDO proxy too — the sun must stay procedural
        // (sun.live false) and never error when the photo can't load.
        await page.route('**/api/solar/**', (r) => r.abort());
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

        // Inject Kp + active regions + a measured GOES X-ray state through
        // the page bus → the oval band appears, the Sun grows its AR
        // markers (one complex), and the star expresses the M-class flux
        // ("the sun always has behavior" — chip + activity probes).
        await page.evaluate(() => {
            const now = Date.now();
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: { kp: 6,
                active_regions: [
                    { region: 14001, lat_rad: 0.2, lon_rad: 1.1, area_norm: 0.5,
                      mag_class: 'beta-gamma-delta', is_complex: true },
                    { region: 14002, lat_rad: -0.15, lon_rad: 2.0, area_norm: 0.2,
                      mag_class: 'beta', is_complex: false },
                ],
                xray_flux: 5e-5,
                xray_series: [
                    { t: now - 30 * 60_000, flux: 2e-6 },
                    { t: now, flux: 5e-5 },
                ],
                recent_flares: [
                    { time: new Date(now - 5 * 60_000).toISOString(),
                      parsed: { letter: 'M' } },
                ] } }));
        });
        await expect.poll(() => page.evaluate(() => window.__swStage?.ovalVisible),
            { timeout: 15_000 }).toBe(true);
        await expect.poll(() => page.evaluate(() => window.__swStage?.sun.regions),
            { timeout: 15_000 }).toBe(2);
        await expect.poll(() => page.evaluate(() => window.__swStage.sun.complex),
            { timeout: 15_000 }).toBe(1);
        // Measured sun behavior at τ ≈ now: M-class → high activity drive,
        // the in-flare-window injection lights the flash envelope, and the
        // vitals chip narrates all of it.
        await expect.poll(() => page.evaluate(() => window.__swStage?.sun.cls),
            { timeout: 15_000 }).toMatch(/^M/);
        await expect.poll(() => page.evaluate(() => window.__swStage.sun.act),
            { timeout: 15_000 }).toBeGreaterThan(0.5);
        await expect(host.locator('.swst-chip', { hasText: 'X-ray' }))
            .toContainText(/X-ray M/);
        await expect.poll(() => page.evaluate(() => window.__swStage?.pinVisible)).toBe(true);
        await expect(host.locator('.swst-pin-label')).toContainText('Fairbanks');
        await expect(host.locator('.swst-pin-label')).toContainText(/oval/);

        // My Sky flight lands at the pin (ground-level: camera well inside
        // the Earth-local neighbourhood) and the S6 sky dome comes up:
        // sky background + the curtain ribbon computed from the SAME oval
        // oracle in az/alt coordinates (geometry asserted, never the
        // wall-clock-dependent lighting), while the ×10.6-exaggerated
        // walls yield to the honest from-below projection.
        await host.locator('.swst-stations button', { hasText: 'My Sky' }).click();
        await expect.poll(() => page.evaluate(() => window.__swStage?.station))
            .toBe('my-sky');
        await expect.poll(() => page.evaluate(() => window.__swStage.mySky.dome),
            { timeout: 15_000 }).toBe(true);
        await expect.poll(() => page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: { kp: 6 } }));
            return window.__swStage.mySky.ribbonPts;
        }), { timeout: 15_000 }).toBeGreaterThan(0);
        expect(await page.evaluate(() => window.__swStage.curtains.visible))
            .toBe(false);   // walls hide under the dome
        expect(await page.evaluate(() => window.__swStage.mySky.sunAltDeg))
            .not.toBeNull();
        // Cardinal horizon marks are part of the dome chrome.
        await expect(host.locator('.swst-overlay')).toContainText('N');
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
        // Offline quiet corridor: the cloud honestly claims NO ensemble
        // (S5b kinds collapse to ambient — measurement, not prediction).
        expect(s0.p.cmeActive).toBe(false);
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

    test('S5d: virtual probe measures the corridor; DONKI-only flares localize', async ({ page }) => {
        const host = page.locator('#sw-stage-host');
        await expect(host.locator('.swst-stations button')).toHaveCount(6, { timeout: 30_000 });

        // Drop a monitor at 0.5 AU, 15° via the deep-link hook (the click
        // path shares it; the mix-aware AU inverse is node-pinned). Offline
        // spec ⇒ climatological 400 km/s ⇒ ~52 h lead to Earth.
        await page.evaluate(() => window.__swStage.setProbe(0.5, 15));
        await expect.poll(() => page.evaluate(() => window.__swStage.probe?.regime),
            { timeout: 15_000 }).toBe('ambient');
        const p = await page.evaluate(() => window.__swStage.probe);
        expect(p.rAu).toBeCloseTo(0.5, 6);
        expect(p.leadHours).toBeGreaterThan(45);
        expect(p.leadHours).toBeLessThan(60);
        expect(p.srcLonDeg).toBeGreaterThan(15);   // Parker source sits west
        await expect(host.locator('.swst-chip', { hasText: '⌖' }))
            .toContainText('0.50 AU');
        await expect(host.locator('.swst-chip', { hasText: '⌖' }))
            .toContainText('ambient');

        // Retrieve it — readout gone.
        await page.evaluate(() => window.__swStage.setProbe(null));
        await expect.poll(() => page.evaluate(() => window.__swStage.probe)).toBe(null);

        // DONKI-only flare sourcing (NOAA's flare JSON is retired — in
        // production flares arrive ONLY via donki_flares) + honest
        // localization at the catalogued AR.
        await page.evaluate(() => {
            const now = Date.now();
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: {
                active_regions: [
                    { region: 14001, lat_rad: 0.2, lon_rad: 1.1, area_norm: 0.5,
                      mag_class: 'beta-gamma-delta', is_complex: true },
                ],
                donki_flares: [
                    { peak_time: new Date(now - 4 * 60_000).toISOString(),
                      class_letter: 'M', active_region: 14001 },
                ] } }));
        });
        await expect.poll(() => page.evaluate(() => window.__swStage.sun.flash),
            { timeout: 15_000 }).toBeGreaterThan(0.3);
        await expect.poll(() => page.evaluate(() => window.__swStage.sun.flareRegion),
            { timeout: 15_000 }).toBe(14001);
        await expect(host.locator('.swst-chip', { hasText: 'X-ray' }))
            .toContainText('FLARE @ AR 14001');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('S5c: SEP streaks gate on the measured S-scale; curtains rise with the oval', async ({ page }) => {
        const host = page.locator('#sw-stage-host');
        await expect(host.locator('.swst-stations button')).toHaveCount(6, { timeout: 30_000 });

        // Quiet corridor first: no protons → no streaks (S0 is honest).
        await expect.poll(() => page.evaluate(() => window.__swStage.sep.on)).toBe(false);

        // Inject a measured S2 proton storm + Kp 6 through the page bus.
        await page.evaluate(() => {
            const now = Date.now();
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: {
                kp: 6,
                proton_flux_10mev: 500,
                proton_series: [
                    { t: now - 3.6e6, flux: 500 },
                    { t: now, flux: 500 },
                ] } }));
        });
        await expect.poll(() => page.evaluate(() => window.__swStage.sep.s),
            { timeout: 15_000 }).toBe(2);
        await expect.poll(() => page.evaluate(() => window.__swStage.sep.visible),
            { timeout: 15_000 }).toBe(true);
        await expect(host.locator('.swst-chip', { hasText: 'SEP' }))
            .toContainText('S2 SEP');

        // Curtains follow the SAME kpBandAt median the oval band draws.
        // The offline feed keeps re-dispatching its quiet fallback (Kp 2),
        // which can overwrite the injected Kp between poll ticks — so the
        // intensity poll re-injects each tick (same race-hardening as the
        // AR test).
        await expect.poll(() => page.evaluate(() => window.__swStage.curtains.visible),
            { timeout: 15_000 }).toBe(true);
        await expect.poll(() => page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: { kp: 6 } }));
            return window.__swStage.curtains.intensity;
        }), { timeout: 15_000 }).toBeGreaterThan(0.3);

        // The disclosure line names the curtain exaggeration.
        await expect(host.locator('.swst-disclose')).toContainText('aurora curtain height');

        // My Sky: heliospheric streaks hide, and the exaggerated curtain
        // WALLS yield to the S6 dome. With no pin there is no observer,
        // so the dome (and any sky) honestly stays down too.
        await host.locator('.swst-stations button', { hasText: 'My Sky' }).click();
        await expect.poll(() => page.evaluate(() => window.__swStage?.station))
            .toBe('my-sky');
        await expect.poll(() => page.evaluate(() => window.__swStage.sep.visible))
            .toBe(false);
        await expect.poll(() => page.evaluate(() => window.__swStage.curtains.visible))
            .toBe(false);
        expect(await page.evaluate(() => window.__swStage.mySky.dome)).toBe(false);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('S7: Moon in the tail at full moon, measured belts, live Shue readout', async ({ page }) => {
        const host = page.locator('#sw-stage-host');
        await expect(host.locator('.swst-stations button')).toHaveCount(6, { timeout: 30_000 });

        // Moon: on its mean orbit, phase from the verdict-engine oracle.
        const m0 = await page.evaluate(() => window.__swStage.moon);
        expect(Math.hypot(m0.xRe, m0.yRe)).toBeCloseTo(60.27, 1);
        expect(m0.illumPct).toBeGreaterThanOrEqual(0);
        expect(m0.illumPct).toBeLessThanOrEqual(100);
        await expect.poll(() => page.evaluate(() => window.__swStage.moon.visible),
            { timeout: 15_000 }).toBe(true);

        // Scrub τ to the next full moon: the Moon crosses the magnetotail
        // (the probe computes from τ synchronously — scan the window).
        const tail = await page.evaluate(() => {
            const now = Date.now();
            for (let d = 0; d <= 30; d += 0.25) {
                window.__swStage.setTau(now + d * 86400e3);
                const m = window.__swStage.moon;
                if (m.inTail) return { d, illum: m.illumPct };
            }
            return null;
        });
        expect(tail).not.toBeNull();
        expect(tail.illum).toBeGreaterThan(85);   // tail crossing ≈ full moon
        await page.evaluate(() => window.__swStage.setTau(Date.now()));

        // Van Allen belts: visible, outer driven by the MEASURED ≥2 MeV
        // electron flux (re-inject each poll tick — the offline feed's
        // quiet fallback overwrites between ticks).
        await expect.poll(() => page.evaluate(() => window.__swStage.belts.visible),
            { timeout: 15_000 }).toBe(true);
        await expect.poll(() => page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('swpc-update',
                { detail: { electron_flux_2mev: 1e5 } }));
            return window.__swStage.belts.outer;
        }), { timeout: 15_000 }).toBe(1);

        // Shue standoff: live readout from the bus wind (fallback 400 km/s
        // offline), in the honest 6–13 R_E range, stated on the nose chip.
        await expect.poll(() => page.evaluate(() => window.__swStage.shue.r0Re),
            { timeout: 15_000 }).toBeGreaterThan(6);
        expect(await page.evaluate(() => window.__swStage.shue.r0Re)).toBeLessThan(13);
        await expect(host.locator('.swst-chip', { hasText: 'Shue' }))
            .toContainText('Rₑ');

        // Offline: the sun stays procedural, honestly labeled not-live —
        // all three S7/S8 live layers down, zero errors.
        expect(await page.evaluate(() => window.__swStage.sun.live)).toBe(false);
        expect(await page.evaluate(() => window.__swStage.sun.corona171)).toBe(false);
        expect(await page.evaluate(() => window.__swStage.sun.magLive)).toBe(false);

        // S8 IMF sector from measured Bx/By (re-inject per tick — the
        // offline fallback's degenerate Bx≡0 makes the oracle refuse,
        // which is itself the honest quiet answer).
        await expect.poll(() => page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: {
                solar_wind: { speed: 480, density: 6, bz: -2, bx: -3, by: 4 } } }));
            return window.__swStage.sun.imfSector;
        }), { timeout: 15_000 }).toBe('away');
        await expect.poll(() => page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: {
                solar_wind: { speed: 480, density: 6, bz: -2, bx: 3, by: -4 } } }));
            return window.__swStage.sun.imfSector;
        }), { timeout: 15_000 }).toBe('toward');
        // Chip narrates the sector (poll re-injects: the offline fallback
        // wipes it to the honest null between ticks).
        await expect.poll(() => page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('swpc-update', { detail: {
                solar_wind: { speed: 480, density: 6, bz: -2, bx: 3, by: -4 } } }));
            return document.querySelector('#sw-stage-host .swst-overlay')?.textContent ?? '';
        }), { timeout: 15_000 }).toContain('IMF toward');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('S9: coronal hole detected on a fixture 171 disk → HSS story chip', async ({ page }) => {
        // Build a synthetic 171 disk (bright, one dark blob EAST of
        // center) and serve it on the aia route — later-registered routes
        // win over the beforeEach abort, exercising the real load→detect
        // path deterministically.
        const png = await page.evaluate(() => {
            const c = document.createElement('canvas');
            c.width = c.height = 512;
            const x = c.getContext('2d');
            x.fillStyle = '#000'; x.fillRect(0, 0, 512, 512);
            x.fillStyle = '#c9a45e';
            x.beginPath(); x.arc(256, 256, 248, 0, 7); x.fill();
            x.fillStyle = '#120e04';
            x.beginPath(); x.arc(150, 250, 52, 0, 7); x.fill();
            return c.toDataURL('image/png').split(',')[1];
        });
        await page.route('**/api/solar/aia**', (route) => route.fulfill({
            contentType: 'image/png', body: Buffer.from(png, 'base64') }));
        await page.reload({ waitUntil: 'domcontentloaded' });
        const host = page.locator('#sw-stage-host');
        await expect(host.locator('.swst-stations button')).toHaveCount(6, { timeout: 30_000 });

        // The detector finds the blob, east-positive, with a plausible area.
        await expect.poll(() => page.evaluate(() => window.__swStage.sun.holes.length),
            { timeout: 20_000 }).toBeGreaterThan(0);
        const h = await page.evaluate(() => window.__swStage.sun.holes[0]);
        expect(h.lonDeg).toBeGreaterThan(10);        // image-left = east
        expect(h.areaFrac).toBeGreaterThan(0.005);
        // The corotation story: a finite HSS ETA in the future window
        // (east hole → meridian in days, transit ~2.9 d more). Set by the
        // next scene update after detection — poll.
        await expect.poll(() => page.evaluate(() => window.__swStage.sun.hssEtaMs),
            { timeout: 15_000 }).toBeGreaterThan(Date.now());
        expect(await page.evaluate(() => window.__swStage.sun.hssEtaMs))
            .toBeLessThan(Date.now() + 12 * 86400e3);
        // Chip narrates it.
        await expect(host.locator('.swst-chip', { hasText: 'coronal hole' }))
            .toContainText('HSS @ Earth');
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
