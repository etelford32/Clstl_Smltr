// flux-rope-live-page.spec.js — browser boot gate for the real-time
// Compounding Flux Rope Simulator (flux-rope-live.html). Complements the
// node gates (flux-rope-live.mjs seeds the trains, flux-rope-noise.mjs the
// background measurement, flux-rope-kernel-smoke.mjs the physics): THIS
// pins that the page boots in BOTH postures —
//   · offline / blocked feeds → the clearly-badged Gannon DEMO train with
//     the compounding analyzer populated from the validated hindcast, and
//   · a mocked live catalog + L1 feed → the LIVE compounding train with
//     measured background noise on display.
// All network is mocked/blocked; runs are deterministic.

import { test, expect } from '@playwright/test';

const ENV_NOISE = /Failed to load resource|ERR_TUNNEL|ERR_FAILED|ERR_NAME|Supabase|dynamically imported module|501/;

test.describe('compounding flux rope simulator (flux-rope-live.html)', () => {
    // The page runs THREE 500-member ensembles per recompute (on/off/final
    // for the analyzer attribution) plus a software-GL raymarch — under
    // parallel-suite CPU contention the demo scenario can brush the global
    // 60 s ceiling, so this spec gets double headroom.
    test.setTimeout(120_000);
    let errors;

    test.beforeEach(async ({ page }) => {
        errors = [];
        page.on('console', (m) => {
            if (m.type() === 'error' && !ENV_NOISE.test(m.text())) errors.push(m.text());
        });
        page.on('pageerror', (e) => errors.push(String(e)));
    });

    test('offline boot: DEMO Gannon train, analyzer + roles + filter', async ({ page }) => {
        await page.route('**/services.swpc.noaa.gov/**', (r) => r.abort());
        await page.route('**/api/donki/**', (r) => r.abort());
        await page.route('**/api/noaa/**', (r) => r.abort());
        await page.route('**/api/cme/**', (r) => r.abort());
        await page.goto('/flux-rope-live.html', { waitUntil: 'domcontentloaded' });

        await expect(page.locator('nav a').first()).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('#frl-mode')).toHaveText(/DEMO · GANNON/, { timeout: 20_000 });
        await expect(page.locator('#frl-mode-note')).toHaveText(/validated Gannon\s+2-rope compounding hindcast/);
        await expect(page.locator('#frl-s-phit')).not.toHaveText('—', { timeout: 20_000 });
        await expect(page.locator('#frl-ens-ms')).toHaveText(/members ×3 .* in \d+ ms/);

        // The train panel carries both ropes with §16 roles resolved.
        await expect(page.locator('#frl-train .frl-cme')).toHaveCount(2);
        await expect(page.locator('#frl-train .frl-role.leader')).toHaveCount(1);
        await expect(page.locator('#frl-train .frl-role.follower')).toHaveCount(1);

        // Analyzer: ON-vs-OFF attribution + the wake pair narrative.
        await expect(page.locator('#frl-analyzer')).toHaveText(/Interaction ON vs OFF/);
        await expect(page.locator('#frl-attr')).toHaveText(/min Bz/);
        await expect(page.locator('#frl-analyzer .frl-pair')).toHaveText(/rides Rope 1's wake/);
        await expect(page.locator('#frl-analyzer .frl-pair')).toHaveText(/wake wind \d+ vs ambient \d+ km\/s/);

        // Background noise measured from the replay archive (storm-robust).
        await expect(page.locator('#frl-noise')).toHaveText(/background σ|unmeasured/);

        // Ledger feed down → visibly broken, never quiet.
        await expect(page.locator('#frl-ledger')).toHaveText(/Scorecard feed unavailable/);

        // Freeze, scrub into the storm: the filter conditions on the
        // archived record left of the now-line and reports ESS.
        await page.locator('#frl-play').click();
        await page.locator('#frl-time').fill('49');
        await expect(page.locator('#frl-assim-status')).toHaveText(/ESS \d+\/\d+/, { timeout: 10_000 });
        await expect(page.locator('#frl-hud-status')).toHaveText(/crossing|overlap|sheath/);

        // WebGL2 heliosphere initialized.
        const glOk = await page.evaluate(() => {
            const c = document.getElementById('frl-gl');
            return !!(c && c.getContext('webgl2'));
        });
        expect(glOk).toBe(true);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('mocked live feeds: LIVE train, real-time now-line, measured noise', async ({ page }) => {
        const now = Date.now();
        const iso = (hAgo) => new Date(now - hAgo * 3600e3).toISOString();
        // DONKI proxy payload shape (api/donki/cme.js → parseDonkiCmes).
        await page.route('**/api/donki/**', (r) => r.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                data: {
                    cmes: [
                        { time: iso(6), cme_id: 'LIVE-B', most_accurate: true, speed_km_s: 1500,
                          latitude_deg: -2, longitude_deg: 5, half_angle_deg: 44,
                          earth_directed: true, note: '' },
                        { time: iso(20), cme_id: 'LIVE-A', most_accurate: true, speed_km_s: 800,
                          latitude_deg: 1, longitude_deg: -4, half_angle_deg: 36,
                          earth_directed: true, note: '' },
                    ],
                },
            }),
        }));
        // Quiet L1 record: 24 h at 5-min cadence, deterministic ±2 nT noise.
        const rows = (field) => {
            const out = [];
            let s = 12345;
            const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5);
            for (let i = 24 * 12; i > 0; i--) {
                const tag = new Date(now - i * 300e3).toISOString().slice(0, 19);
                out.push(field === 'mag'
                    ? { time_tag: tag, bx_gsm: rnd(), by_gsm: 3 * rnd(), bz_gsm: 4 * rnd() }
                    : { time_tag: tag, proton_speed: 430 + 20 * rnd(), proton_density: 5 + rnd() });
            }
            return out;
        };
        // Catch-all abort FIRST — Playwright matches routes newest-first, so
        // the specific RTSW fulfills below must be registered after it.
        await page.route('**/services.swpc.noaa.gov/**', (r) => r.abort());
        await page.route('**/services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json', (r) =>
            r.fulfill({ contentType: 'application/json', body: JSON.stringify(rows('mag')) }));
        await page.route('**/services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json', (r) =>
            r.fulfill({ contentType: 'application/json', body: JSON.stringify(rows('wind')) }));
        // Per-flare validation ledger: one resolved flare-tagged event with
        // the flux-rope-v1 locked row + truth, plus the model skill table.
        await page.route('**/api/cme/skill**', (r) => r.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ data: {
                models: [
                    { model_id: 'flux-rope-v1', is_hindcast: false, n_scored: 3, mae_hours: 8.2 },
                    { model_id: 'dbm-v1', is_hindcast: false, n_scored: 9, mae_hours: 10.4 },
                ],
                events: [{
                    event_id: 'PP-RT-LEDGER-1',
                    launch: iso(96),
                    forecasts: { 'flux-rope-v1': {
                        predicted: iso(96 - 47), early: iso(96 - 51), late: iso(96 - 41),
                        p_hit: 0.78, p10: 0.55, p20: 0.3, min_bz_p50: -16, min_bz_p5: -31,
                        n_train: 2,
                        flare: { id: 'FLR-1', class: 'X1.2', region: 13999, dt_h: 0.7 },
                    } },
                    truth: { arrived: true, shock: iso(96 - 49), min_bz_nt: -19 },
                }],
            } }),
        }));
        await page.goto('/flux-rope-live.html', { waitUntil: 'domcontentloaded' });

        await expect(page.locator('#frl-mode')).toHaveText(/LIVE · 2 CMEs IN FLIGHT/, { timeout: 20_000 });
        await expect(page.locator('#frl-mode-note')).toHaveText(/Live compounding watch/);
        await expect(page.locator('#frl-mode-note')).toHaveText(/last 24 h/);
        await expect(page.locator('#frl-s-phit')).not.toHaveText('—', { timeout: 20_000 });
        await expect(page.locator('#frl-train .frl-cme')).toHaveCount(2);
        await expect(page.locator('#frl-membership')).toHaveText(/2 in the modeled train/);

        // Real-time discipline: the now-line runs at ×1 near wall-clock now
        // (epoch was 20 h ago → cursor ≈ +20 h).
        await expect(page.locator('#frl-t-label')).toHaveText(/×1$/);
        const cursor = parseFloat(await page.locator('#frl-time').inputValue());
        expect(Math.abs(cursor - 20)).toBeLessThan(0.5);

        // Analyzer: the fast follower rides the slow leader's wake.
        await expect(page.locator('#frl-analyzer .frl-pair')).toHaveText(/Rope 2 ← rides Rope 1's wake/);

        // Measured background: the injected record is ~±2 nT quiet noise —
        // the panel and the filter must both cite a measured σ.
        await expect(page.locator('#frl-noise')).toHaveText(/background σ \(Bz\)/);
        await expect(page.locator('#frl-noise')).toHaveText(/trailing 24 h of live L1/);
        await expect(page.locator('#frl-assim-status')).toHaveText(/measured|armed|prior/, { timeout: 10_000 });

        // The per-flare ledger: flare tag, locked-vs-truth error chip, skill.
        await expect(page.locator('#frl-skill-chip')).toHaveText(/MAE 8\.2 h · n 3/);
        await expect(page.locator('#frl-ledger')).toHaveText(/☀ X1\.2 · AR13999/);
        await expect(page.locator('#frl-ledger')).toHaveText(/-2\.0 h/);
        await expect(page.locator('#frl-ledger')).toHaveText(/min Bz p50 -16 nT/);
        await expect(page.locator('#frl-ledger')).toHaveText(/truth: shock .* min Bz -19 nT \(Δ 3\)/);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });
});
