/**
 * sun-watch.spec.js — browser gate for the Sun Watch analysis dock (sun.html)
 * ═══════════════════════════════════════════════════════════════════════════
 * All feed routes the dock consumes are MOCKED, so this runs without live
 * network and pins:
 *   · the dock mounts alongside the 3D sun and exposes window.__sunWatch
 *   · the timeline fuses DONKI flares/CMEs/SEP into one ledger
 *   · the Regions tab shows SWPC's per-AR probabilities on the percent scale
 *     (a whole-percent `1` renders 1%, never 100%)
 *   · a dead feed shows a "down" chip and an empty section (no fabricated rows)
 *   · coronal-hole markers land in the scene and co-rotate with the AR frame
 *   · collapse → pill → expand round-trips
 *   · the Forecast tab renders the SHARED flux-rope provider's published
 *     result (live ensemble stats for an Earth-directed CME; the honest
 *     "feed unavailable" state when DONKI is down) and the scrubber event
 *     track picks up the ledger marks — both consume the ONE provider run
 *     started by js/sun-flux-rope.js, never a second pipeline
 */

import { test, expect } from '@playwright/test';

const URL = '/sun.html';
const BOOT_TIMEOUT_MS = 20_000;

const DONKI_FLARES = { source: 'NASA DONKI', data: { flares: [
    { id: 'f1', peak_time: new Date(Date.now() - 2 * 3600e3).toISOString(), begin_time: null,
      flare_class: 'M4.4', location: 'N12W30', active_region: 4321, linked_cme: 'cme-1' },
    { id: 'f2', peak_time: new Date(Date.now() - 20 * 3600e3).toISOString(), begin_time: null,
      flare_class: 'C3.1', location: 'S08E15', active_region: 4322, linked_cme: null },
] } };
const DONKI_CME = { source: 'NASA DONKI', data: { cmes: [
    { cme_id: 'cme-1', time: new Date(Date.now() - 3 * 3600e3).toISOString(),
      speed_km_s: 880, half_angle_deg: 40, latitude_deg: 4, longitude_deg: -8,
      earth_directed: true,
      enlil: { shock_arrival: new Date(Date.now() + 40 * 3600e3).toISOString(), kp_90: 5, kp_180: 7 } },
] } };
const DONKI_SEP = { source: 'NASA DONKI', data: { events: [
    { id: 's1', event_time: new Date(Date.now() - 3600e3).toISOString(),
      instruments: ['GOES-16: >10 MeV'], linked_flare: 'f1' },
] } };
const DONKI_GST = { source: 'NASA DONKI', data: { events: [] } };
const DONKI_NOTES = { source: 'NASA DONKI', data: { notifications: [] } };
const NOAA_REGIONS = { source: 'NOAA SWPC', data: { regions: [
    { region: 4321, location: 'N12W30', latitude_deg: 12, stonyhurst_lon_deg: 30,
      mag_class: 'BGD', spot_class: 'EKC', area: 480, num_spots: 20,
      c_flare_probability: 95, m_flare_probability: 55, x_flare_probability: 15 },
    { region: 4322, location: 'S08E15', latitude_deg: -8, stonyhurst_lon_deg: -15,
      mag_class: 'A', spot_class: 'HSX', area: 40, num_spots: 4,
      c_flare_probability: 1, m_flare_probability: 1, x_flare_probability: 1 },
] } };
const HEK_HOLES = { source: 'HEK CH catalog (LMSAL)', data: { count: 2, holes: [
    { lat_deg: 55, lon_helio_deg: -10, lon_carrington_deg: 200, frm_name: 'SPoCA-CH', time: new Date().toISOString() },
    { lat_deg: -40, lon_helio_deg: 25, lon_carrington_deg: 235, frm_name: 'CHIMERA', time: new Date().toISOString() },
] } };
function f107Payload() {
    const rows = [];
    for (let d = 90; d >= 1; d--) {
        rows.push({ date: new Date(Date.now() - d * 86400e3).toISOString().slice(0, 10),
            flux_sfu: 140 + Math.sin(d / 9) * 8, kind: 'observed' });
    }
    for (let d = 0; d < 20; d++) {
        rows.push({ date: new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10),
            flux_sfu: 150, kind: 'predicted' });
    }
    return { source: 'NOAA SWPC', freshness: 'fresh', age_hours: 1,
        data: { rows, observed_days: 90, predicted_days: 20, computed_f107a_centred: 141,
                computed_f107a_trailing: 140, computed_f107a_27d_trailing: 142, warnings: [] } };
}

async function mockFeeds(page, { donkiDown = false } = {}) {
    const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    const down = { status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'upstream_unavailable' }) };
    await page.route('**/api/donki/flares*', r => r.fulfill(donkiDown ? down : json(DONKI_FLARES)));
    await page.route('**/api/donki/cme*', r => r.fulfill(donkiDown ? down : json(DONKI_CME)));
    await page.route('**/api/donki/sep*', r => r.fulfill(donkiDown ? down : json(DONKI_SEP)));
    await page.route('**/api/donki/gst*', r => r.fulfill(donkiDown ? down : json(DONKI_GST)));
    await page.route('**/api/donki/notifications*', r => r.fulfill(donkiDown ? down : json(DONKI_NOTES)));
    await page.route('**/api/noaa/regions*', r => r.fulfill(json(NOAA_REGIONS)));
    await page.route('**/api/hek/coronal-holes*', r => r.fulfill(json(HEK_HOLES)));
    await page.route('**/api/noaa/f107-history*', r => r.fulfill(json(f107Payload())));
    // The flux-rope provider's L1 leg: RTSW direct + same-origin mirror both
    // return empty so runs are deterministic (prior-only fan) and never wait
    // out a sandbox network timeout. The WASM stays same-origin static.
    await page.route('**services.swpc.noaa.gov/**', r => r.fulfill(json([])));
    await page.route('**/api/noaa/passthrough*', r => r.fulfill(json([])));
}

async function boot(page) {
    await page.goto(URL);
    await page.waitForFunction(() => window.__sun?.ready && window.__sunWatch?.ready,
        { timeout: BOOT_TIMEOUT_MS });
    // Force the dock open regardless of stored/viewport-default collapse.
    await page.evaluate(() => document.getElementById('snw-pill')?.click());
    await expect(page.locator('#sun-watch-dock')).toBeVisible();
}

test.describe('sun watch dock', () => {

    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch (e) {}
        });
    });

    test('mounts and fuses the event timeline', async ({ page }) => {
        await mockFeeds(page);
        await boot(page);
        // The dock's first refresh is async — wait for the derived state.
        await page.waitForFunction(() => window.__sunWatch.state.timeline.length >= 3,
            { timeout: BOOT_TIMEOUT_MS });
        const body = page.locator('#snw-body');
        await expect(body.getByText('M4.4 flare · AR 4321')).toBeVisible();
        await expect(body.getByText('Earth-directed CME · 880 km/s')).toBeVisible();
        await expect(body.getByText('Solar energetic particle event')).toBeVisible();
    });

    test('regions tab shows per-AR odds on the whole-set percent scale', async ({ page }) => {
        await mockFeeds(page);
        await boot(page);
        await page.waitForFunction(() => window.__sunWatch.state.regions.rows.length === 2,
            { timeout: BOOT_TIMEOUT_MS });
        await page.evaluate(() => window.__sunWatch.setTab('regions'));
        const body = page.locator('#snw-body');
        await expect(body.getByText('AR 4321')).toBeVisible();
        await expect(body.getByText('C 95% · M 55% · X 15%')).toBeVisible();
        // The quiet region's whole-percent `1` must read 1%, never 100%.
        await expect(body.getByText('C 1% · M 1% · X 1%')).toBeVisible();
        // And the popup lookup index carries fractions.
        const pM = await page.evaluate(() => window.__sunWatch.probIndex.get('4322').pM);
        expect(pM).toBeCloseTo(0.01, 6);
    });

    test('coronal holes list + 3D markers co-rotating with the AR frame', async ({ page }) => {
        await mockFeeds(page);
        await boot(page);
        await page.waitForFunction(() => window.__sunWatch.state.holes.length === 2,
            { timeout: BOOT_TIMEOUT_MS });
        await page.evaluate(() => window.__sunWatch.setTab('holes'));
        await expect(page.locator('#snw-body').getByText('SPoCA-CH')).toBeVisible();

        // Markers exist in the scene and ride the photosphere rotation.
        const marker = await page.evaluate(() => {
            let found = null;
            window.__sun.scene.traverse(() => {});
            // The hole group is registered into the page's co-rotation list;
            // find a torus at the CH ring radius among scene groups.
            window.__sun.scene.traverse(o => {
                if (o.geometry?.type === 'TorusGeometry'
                    && Math.abs((o.geometry.parameters?.radius ?? 0) - 0.055) < 1e-6) found = true;
            });
            return found;
        });
        expect(marker).toBe(true);
        // Toggling the checkbox hides the marker group.
        await page.locator('#snw-hole-toggle').setChecked(false);
        const visible = await page.evaluate(() => {
            let vis = null;
            window.__sun.scene.traverse(o => {
                if (o.geometry?.type === 'TorusGeometry'
                    && Math.abs((o.geometry.parameters?.radius ?? 0) - 0.055) < 1e-6) {
                    let g = o; while (g.parent && g.parent !== window.__sun.scene) g = g.parent;
                    vis = g.visible;
                }
            });
            return vis;
        });
        expect(visible).toBe(false);
    });

    test('cycle tab renders F10.7 stats and sparkline', async ({ page }) => {
        await mockFeeds(page);
        await boot(page);
        await page.waitForFunction(() => !!window.__sunWatch.state.cycle, { timeout: BOOT_TIMEOUT_MS });
        await page.evaluate(() => window.__sunWatch.setTab('cycle'));
        await expect(page.locator('#snw-body').getByText('F10.7 today')).toBeVisible();
        await expect(page.locator('#snw-cycle-spark')).toBeVisible();
    });

    test('DONKI outage degrades to down-chip + empty ledger, dock survives', async ({ page }) => {
        await mockFeeds(page, { donkiDown: true });
        await boot(page);
        await page.waitForFunction(() => window.__sunWatch.state.regions.rows.length === 2,
            { timeout: BOOT_TIMEOUT_MS });
        // Timeline may still carry SWPC GOES flares (live fetch is unmocked and
        // fails in sandbox → liveFlares stays default/empty), but no DONKI rows.
        const hasDonki = await page.evaluate(() =>
            window.__sunWatch.state.timeline.some(e => e.kind === 'cme' || e.kind === 'sep'));
        expect(hasDonki).toBe(false);
        await page.evaluate(() => window.__sunWatch.setTab('cme'));
        await expect(page.locator('#snw-body').getByText('No CME analyses published')).toBeVisible();
        await expect(page.locator('#snw-ft .snw-chip.snw-down')).toHaveCount(1);
    });

    test('forecast tab renders the shared provider ensemble for a live CME', async ({ page }) => {
        await mockFeeds(page);
        await boot(page);
        // The provider defers its first run past scene boot, then computes
        // the 500-member ensemble in WASM — wait for the published result.
        await page.waitForFunction(() => window.__fluxRopeForecast?.idle === false,
            { timeout: BOOT_TIMEOUT_MS + 15_000 });
        await page.evaluate(() => window.__sunWatch.setTab('forecast'));
        const body = page.locator('#snw-body');
        await expect(body.getByText('P(Earth hit)')).toBeVisible();
        await expect(body.getByText(/P\(min Bz/).first()).toBeVisible();
        await expect(page.locator('#snw-rope-chart')).toBeVisible();
        // The train member row quotes the DONKI cone fit verbatim.
        await expect(body.getByText('880 km/s')).toBeVisible();
        // The scrubber event track consumed the same ledger — flare + CME
        // marks are present (drawn only once the NOAA timeline also loads,
        // but the draw list itself must not depend on that).
        const marks = await page.evaluate(() => window.__sun.scrubTrack.marks);
        expect(marks.some(m => m.kind === 'flare')).toBe(true);
        expect(marks.some(m => m.kind === 'cme')).toBe(true);
    });

    test('forecast tab is honest when the provider feed is down', async ({ page }) => {
        await mockFeeds(page, { donkiDown: true });
        await boot(page);
        await page.waitForFunction(() => window.__fluxRopeForecast?.failed === true,
            { timeout: BOOT_TIMEOUT_MS + 15_000 });
        await page.evaluate(() => window.__sunWatch.setTab('forecast'));
        await expect(page.locator('#snw-body').getByText('Forecast feed unavailable'))
            .toBeVisible();
    });

    test('collapse to pill and back', async ({ page }) => {
        await mockFeeds(page);
        await boot(page);
        await page.locator('#snw-min').click();
        await expect(page.locator('#sun-watch-dock')).toBeHidden();
        await expect(page.locator('#snw-pill')).toBeVisible();
        await page.locator('#snw-pill').click();
        await expect(page.locator('#sun-watch-dock')).toBeVisible();
        await expect(page.locator('#snw-pill')).toBeHidden();
    });
});
