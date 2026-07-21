// flux-rope-smoke.spec.js — browser boot gate for the Flux Rope Simulator
// page (flux-rope.html). Complements the node kernel gate
// (tests/flux-rope-kernel-smoke.mjs): that pins the physics; THIS pins that
// the page actually boots — nav renders, WASM loads, the WebGL2 heliosphere
// initializes, the τ-clock runs, the ensemble auto-runs, the particle
// filter conditions the fan at the now-line, and slider edits recompute
// without page errors. Live feeds (SWPC RTSW, DONKI proxy) are BLOCKED so
// the run is deterministic and offline — the page must degrade gracefully,
// which is itself under test. Hindcast overlays come from committed bundles.

import { test, expect } from '@playwright/test';

// Environmental noise that is not the page's fault (blocked CDNs, offline
// API routes in the sandbox). Anything else — shader compile failures,
// module errors, uncaught exceptions — still fails the run.
const ENV_NOISE = /Failed to load resource|ERR_TUNNEL|ERR_FAILED|ERR_NAME|Supabase|dynamically imported module|501/;

test.describe('flux-rope simulator', () => {
    let errors;

    test.beforeEach(async ({ page }) => {
        errors = [];
        page.on('console', (m) => {
            if (m.type() === 'error' && !ENV_NOISE.test(m.text())) errors.push(m.text());
        });
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.route('**/services.swpc.noaa.gov/**', (r) => r.abort());
        await page.route('**/api/donki/**', (r) => r.abort());
        await page.goto('/flux-rope.html', { waitUntil: 'domcontentloaded' });
    });

    test('boots: nav, WebGL2 view, kernel, ensemble, τ-clock', async ({ page }) => {
        // The canonical nav must render (initNav populates the <nav> shell —
        // this page shipped once WITHOUT the shell and lost its navigation).
        await expect(page.locator('nav a').first()).toBeVisible({ timeout: 20_000 });
        // Ensemble stats fill in once the WASM kernel has run.
        await expect(page.locator('#fr-s-phit')).not.toHaveText('—', { timeout: 20_000 });
        await expect(page.locator('#fr-ens-ms')).toHaveText(/members in \d+ ms/);
        const pHit = parseInt(await page.locator('#fr-s-phit').textContent(), 10);
        expect(pHit).toBeGreaterThan(40);
        // τ-clock: UTC timestamp + compression factor in the readout.
        await expect(page.locator('#fr-t-label')).toHaveText(/03-1\d \d\d:\d\dZ .* ×100/);
        // WebGL2 heliosphere initialized (raymarch shader requires it).
        const glOk = await page.evaluate(() => {
            const c = document.getElementById('fr-gl');
            return !!(c && c.getContext('webgl2'));
        });
        expect(glOk).toBe(true);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('now-line particle filter: conditions, reports ESS/λ, resets', async ({ page }) => {
        await expect(page.locator('#fr-s-phit')).not.toHaveText('—', { timeout: 20_000 });
        // Filter armed but not yet conditioned at t≈0.
        await expect(page.locator('#fr-assim-status')).toHaveText(/particle filter armed/);
        // Freeze the clock, drag the now-line into the observed storm.
        await page.locator('#fr-play').click();
        await page.locator('#fr-time').fill('62');
        await expect(page.locator('#fr-assim-status')).toHaveText(/ESS \d+\/\d+/, { timeout: 10_000 });
        await expect(page.locator('#fr-assim-status')).toHaveText(/\d+ obs/);
        // Toggling the filter off restores the prior fan.
        await page.locator('#a-toggle').click();
        await expect(page.locator('#fr-assim-status')).toHaveText(/particle filter off/);
        await page.locator('#a-toggle').click();
        await expect(page.locator('#fr-assim-status')).toHaveText(/ESS \d+\/\d+/, { timeout: 10_000 });
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('scrubber drives the HUD through transit and L1 crossing', async ({ page }) => {
        await expect(page.locator('#fr-s-phit')).not.toHaveText('—', { timeout: 20_000 });
        await page.locator('#fr-play').click();
        await page.locator('#fr-time').fill('62');
        await expect(page.locator('#fr-hud-status')).toHaveText(/crossing L1/);
        await expect(page.locator('#fr-hud-r')).toHaveText(/AU/);
        await page.locator('#fr-time').fill('5');
        await expect(page.locator('#fr-hud-status')).toHaveText(/in transit/);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('gannon train preset: rope tabs, joint ensemble, train editing', async ({ page }) => {
        await expect(page.locator('#fr-s-phit')).not.toHaveText('—', { timeout: 20_000 });
        await page.locator('#fr-preset').selectOption('gannon-2024');
        await expect(page.locator('#fr-ropetabs button.active')).toHaveText(/Rope 1/);
        await expect(page.locator('#fr-ropetabs button', { hasText: 'Rope 2 · +20h' })).toBeVisible();
        await expect(page.locator('#fr-s-arr')).toHaveText(/05-1\d \d\d:\d\d/, { timeout: 15_000 });
        const p20 = parseInt(await page.locator('#fr-s-p20').textContent(), 10);
        expect(p20).toBeGreaterThan(40);
        await page.locator('#fr-ropetabs button', { hasText: 'Rope 2' }).click();
        await expect(page.locator('#p-v0Kms')).toHaveValue('1300');
        await page.locator('#fr-ropetabs button.fr-add').click();
        await expect(page.locator('#fr-ropetabs button.active')).toHaveText(/Rope 3/);
        await expect(page.locator('#fr-preset')).toHaveValue('custom');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('slider edit switches to custom and recomputes live', async ({ page }) => {
        await expect(page.locator('#fr-s-phit')).not.toHaveText('—', { timeout: 20_000 });
        const before = await page.locator('#fr-ens-ms').textContent();
        await page.locator('#p-v0Kms').fill('1600');
        await expect(page.locator('#fr-preset')).toHaveValue('custom');
        await expect(page.locator('#fr-ens-ms')).not.toHaveText(before ?? '', { timeout: 10_000 });
        await expect(page.locator('#fr-s-phit')).toHaveText(/%$/);
        await expect(page.locator('#fr-s-arr')).toHaveText(/\+\d+ h|miss/);
        // Custom events carry no observed data — the filter says so plainly.
        await expect(page.locator('#fr-assim-status')).toHaveText(/no observed data/);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });
});
