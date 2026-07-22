// gannon-dst-smoke.spec.js — browser gate for the three-way Dst validation
// section on gannon-superstorm.html (js/gannon-dst-compare.js). The node
// gate (tests/gannon-dst-compare.mjs) pins the numbers; THIS pins that the
// section actually renders in-page: WASM loads, both pipeline legs compute,
// the chart + skill table appear, the SYM-H truth trace consumes the mocked
// OMNI proxy, and the BATS-R-US slot honestly reports "pending".

import { test, expect } from '@playwright/test';

const ENV_NOISE = /Failed to load resource|ERR_TUNNEL|ERR_FAILED|ERR_NAME|Supabase|dynamically imported module|501|404/;

// Minimal SYM-H fixture over the bundle window: quiet start, deep G5 dip.
const SYMH_FIXTURE = (() => {
    const t = [], sym_h = [];
    const start = Date.parse('2024-05-10T12:00:00Z');
    for (let h = 0; h <= 72; h++) {
        t.push(new Date(start + h * 3.6e6).toISOString());
        sym_h.push(h < 5 ? -12 : h < 20 ? -60 - 20 * (h - 5) : h < 30 ? -500 + 25 * (h - 20) : -120 + h);
    }
    return { data: { t, sym_h } };
})();

test.describe('gannon three-way Dst validation', () => {
    let errors;

    test.beforeEach(async ({ page }) => {
        errors = [];
        page.on('console', (m) => {
            if (m.type() === 'error' && !ENV_NOISE.test(m.text())) errors.push(m.text());
        });
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.route('**/api/omni/imf*', (r) => r.fulfill({ json: SYMH_FIXTURE }));
        // Everything else external stays offline — the page must degrade.
        await page.route('**/services.swpc.noaa.gov/**', (r) => r.abort());
        await page.goto('/gannon-superstorm.html', { waitUntil: 'domcontentloaded' });
    });

    test('section renders: chart, ordered skill table, honest BATS-R-US slot', async ({ page }) => {
        const host = page.locator('#gn-dst-compare');
        await expect(host.locator('canvas.gdc-chart')).toBeVisible({ timeout: 30_000 });
        // Skill table: both pipeline legs + the ensemble p50 row.
        await expect(host.locator('.gdc-table tr')).toHaveCount(4);
        await expect(host.locator('.gdc-table')).toContainText('observed L1 drivers');
        await expect(host.locator('.gdc-table')).toContainText('flux-rope train (det)');
        // With the mocked truth, Δt(min) and RMSE columns must be populated.
        await expect(host.locator('.gdc-table')).not.toContainText('— h');
        // The BATS-R-US slot stays dark and says so.
        await expect(host.locator('.gdc-legend')).toContainText('pending workstation run');
        // The honesty note is part of the deliverable.
        await expect(host.locator('.gdc-note')).toContainText('reproduction skill');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });
});
