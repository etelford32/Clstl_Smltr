// space-weather-compose.spec.js — browser gate for the D1 customization
// loop on space-weather.html (SPACE_WEATHER_DASHBOARD_PLAN.md §6/§12):
// enter design mode → apply a persona preset → adjust it in the gallery
// drawer → save → reload → the personal layout (v2, preset-attributed)
// is restored. The pure algebra is pinned by tests/layout-lab.mjs and
// tests/space-weather-registry.mjs; THIS pins that the loop works in-page.

import { test, expect } from '@playwright/test';

const URL = '/space-weather.html';

test.describe('space-weather dashboard composition (Layout Lab v2)', () => {

    test.beforeEach(async ({ page }) => {
        // The page is sign-in gated; seed the pp_auth mirror (see
        // tests/space-weather-gate.spec.js for the gate's own coverage).
        // Also pre-seed cookie consent — the banner is fixed bottom chrome
        // and would intercept clicks on the Customize button (house
        // pattern, per sun-smoke.spec.js).
        await page.addInitScript(() => {
            localStorage.setItem('pp_auth', JSON.stringify({
                signedIn: true, id: 'e2e-compose', email: 'e2e@playwright.test',
                plan: 'free', role: 'user', provider: 'password',
            }));
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch {}
        });
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#lab-open', { timeout: 20_000 });
    });

    test('apply preset → gallery tweak → save → reload restores the layout', async ({ page }) => {
        await page.click('#lab-open');
        await expect(page.locator('#lab-toolbar')).toBeVisible();

        // The picker carries the five persona presets from the committed
        // presets JSON, grouped separately from the A/B QA variants.
        const presetOptions = page.locator('#lab-toolbar optgroup[label="Presets"] option');
        await expect(presetOptions).toHaveCount(5);

        // Apply the Satellite Operator preset: metrics strip leads, the
        // sim canvas and solar-system notes hide, drag card goes wide.
        await page.selectOption('#lab-toolbar select', 'preset:operator');
        const firstPanel = page.locator('#sw-app > [data-lab-panel]').first();
        await expect(firstPanel).toHaveAttribute('data-lab-panel', 'metrics-hero');
        await expect(page.locator('[data-lab-panel="helio-hero"]')).toHaveClass(/lab-hidden/);
        await expect(page.locator('[data-lab-panel="card-upper-atmosphere"]')).toHaveClass(/lab-wide/);

        // Gallery drawer: one row per registry panel; "adding" a hidden
        // panel un-hides it (D1 semantics).
        await page.getByRole('button', { name: /Gallery/ }).click();
        await expect(page.locator('#lab-gallery')).toBeVisible();
        await expect(page.locator('#lab-gallery .lab-gallery-row')).toHaveCount(23);
        await expect(page.locator('#lab-gallery .lab-gallery-missing')).toHaveCount(0);
        const helioRow = page.locator('#lab-gallery .lab-gallery-row',
            { hasText: 'Heliosphere simulation' });
        await helioRow.locator('button').click();
        await expect(page.locator('[data-lab-panel="helio-hero"]')).not.toHaveClass(/lab-hidden/);

        // Save → the persisted doc is v2 and remembers its preset lineage.
        await page.getByRole('button', { name: /Save mine/ }).click();
        const saved = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('pp-layout.space-weather')));
        expect(saved.v).toBe(2);
        expect(saved.preset).toBe('operator');
        expect(saved.zones.main.order[0]).toBe('metrics-hero');
        expect(saved.zones.main.hidden).toContain('solar-system-info');
        expect(saved.zones.main.hidden).not.toContain('helio-hero');

        // Reload: the personal layout applies at boot, no design mode needed.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#lab-open', { timeout: 20_000 });
        await expect(page.locator('#sw-app > [data-lab-panel]').first())
            .toHaveAttribute('data-lab-panel', 'metrics-hero');
        await expect(page.locator('[data-lab-panel="solar-system-info"]')).toHaveClass(/lab-hidden/);
        await expect(page.locator('[data-lab-panel="helio-hero"]')).not.toHaveClass(/lab-hidden/);
    });

    test('status band renders four cells and tracks #kp-val', async ({ page }) => {
        // Generous first wait: the band mounts after the page's heavy
        // module graph, which is slow on a cold software-GL CI run.
        const cells = page.locator('#sw-status-band .swb-cell');
        await expect(cells).toHaveCount(4, { timeout: 30_000 });
        for (const id of ['outlook', 'arrival', 'kp', 'tonight']) {
            await expect(page.locator(`#sw-status-band [data-cell="${id}"]`)).toBeVisible();
        }
        // Storm-Kp injection via the page's #kp-val (the band's only Kp
        // source — the UA-card MutationObserver pattern).
        await page.evaluate(() => {
            const el = document.getElementById('kp-val');
            if (el) el.textContent = '7';
        });
        const kpCell = page.locator('#sw-status-band [data-cell="kp"]');
        await expect(kpCell.locator('.swb-value')).toHaveText('7');
        await expect(kpCell).toHaveClass(/severe/);
        await expect(kpCell.locator('.swb-detail')).toContainText('G3');
    });
});
