// flux-rope-smoke.spec.js — browser boot gate for the Flux Rope Simulator
// page (flux-rope.html). Complements the node kernel gate
// (tests/flux-rope-kernel-smoke.mjs): that pins the physics; THIS pins that
// the page actually boots — WASM loads, the ensemble auto-runs, the stats
// strip and charts populate, the scrubber drives the HUD, and slider edits
// recompute without console errors. The observed overlay is served from the
// committed hindcast bundle, so no live network is needed.

import { test, expect } from '@playwright/test';

test.describe('flux-rope simulator', () => {
    let errors;

    test.beforeEach(async ({ page }) => {
        errors = [];
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto('/flux-rope.html', { waitUntil: 'domcontentloaded' });
    });

    test('boots: kernel loads, ensemble runs, stats populate', async ({ page }) => {
        // The ensemble stats fill in once the WASM kernel has run.
        await expect(page.locator('#fr-s-phit')).not.toHaveText('—', { timeout: 20_000 });
        await expect(page.locator('#fr-s-phit')).toHaveText(/%$/);
        await expect(page.locator('#fr-ens-ms')).toHaveText(/members in \d+ ms/);
        // St. Patrick's default preset: a storm must be called with real odds.
        const pHit = parseInt(await page.locator('#fr-s-phit').textContent(), 10);
        expect(pHit).toBeGreaterThan(40);
        await expect(page.locator('#fr-s-minbz')).toHaveText(/-\d+ nT/);
        // Median arrival renders as a UTC stamp for the dated preset.
        await expect(page.locator('#fr-s-arr')).toHaveText(/03-1\d \d\d:\d\d/);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('scrubber drives the HUD through transit and L1 crossing', async ({ page }) => {
        await expect(page.locator('#fr-s-phit')).not.toHaveText('—', { timeout: 20_000 });
        // Freeze playback, then scrub to a mid-storm hour.
        await page.locator('#fr-play').click();
        await page.locator('#fr-time').fill('62');
        await expect(page.locator('#fr-hud-status')).toHaveText(/crossing L1/);
        await expect(page.locator('#fr-hud-r')).toHaveText(/AU/);
        // And back to launch: in transit again.
        await page.locator('#fr-time').fill('5');
        await expect(page.locator('#fr-hud-status')).toHaveText(/in transit/);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('gannon train preset: rope tabs, joint ensemble, train editing', async ({ page }) => {
        await expect(page.locator('#fr-s-phit')).not.toHaveText('—', { timeout: 20_000 });
        await page.locator('#fr-preset').selectOption('gannon-2024');
        // Two rope tabs render with launch offsets.
        await expect(page.locator('#fr-ropetabs button.active')).toHaveText(/Rope 1/);
        await expect(page.locator('#fr-ropetabs button', { hasText: 'Rope 2 · +20h' })).toBeVisible();
        // Joint train ensemble populates severe-storm odds and a May arrival.
        await expect(page.locator('#fr-s-arr')).toHaveText(/05-1\d \d\d:\d\d/, { timeout: 15_000 });
        const p20 = parseInt(await page.locator('#fr-s-p20').textContent(), 10);
        expect(p20).toBeGreaterThan(40);
        // Switching tabs retargets the sliders (rope B's fitted v0 = 1300).
        await page.locator('#fr-ropetabs button', { hasText: 'Rope 2' }).click();
        await expect(page.locator('#p-v0Kms')).toHaveValue('1300');
        // Adding a rope grows the train and breaks the hindcast link → custom.
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
        // Recompute happened (member/ms readout re-rendered) and stats stay sane.
        await expect(page.locator('#fr-ens-ms')).not.toHaveText(before ?? '', { timeout: 10_000 });
        await expect(page.locator('#fr-s-phit')).toHaveText(/%$/);
        // Dateless custom event → launch-relative arrival label.
        await expect(page.locator('#fr-s-arr')).toHaveText(/\+\d+ h|miss/);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });
});
