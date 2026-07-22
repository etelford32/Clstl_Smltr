// space-weather-d2.spec.js — browser gate for the D2 personalization
// arc on space-weather.html: the §8 threshold profile (⚙ editor on the
// status band + Kp-cell escalation + Stage handoff), schema-driven panel
// config sheets (gallery ⚙ → live apply → persisted boot), the header
// location box (js/sw-location-box.js → the ONE ppx_user_location store),
// and the Basic+ cloud sync against a MOCKED dashboards REST surface
// (supabase-dashboards-migration.sql is APPLIED in prod, 2026-07-22 —
// the migration-missing path stays pinned for other environments).

import { test, expect } from '@playwright/test';

const SB_REST = '**/rest/v1/dashboards*';

function seed(page, { plan = 'basic', sbToken = true } = {}) {
    return page.addInitScript(({ plan, sbToken }) => {
        localStorage.setItem('pp_auth', JSON.stringify({
            signedIn: true, id: 'e2e-d2-user', email: 'e2e@playwright.test',
            plan, role: 'user', provider: 'password',
        }));
        if (sbToken) {
            localStorage.setItem('sb-e2e-auth-token',
                JSON.stringify({ access_token: 'e2e-'.padEnd(48, 'x') }));
        }
        try {
            localStorage.setItem('pp_consent_v1', JSON.stringify(
                { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        } catch {}
    }, { plan, sbToken });
}

test.describe('D2 personalization', () => {

    test('threshold profile: ⚙ editor saves, Kp cell escalates at YOUR line', async ({ page }) => {
        await seed(page);
        await page.route(SB_REST, (r) => r.fulfill({ json: [] }));
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });
        const band = page.locator('#sw-status-band');
        await expect(band.locator('.swb-cell')).toHaveCount(4, { timeout: 30_000 });

        await band.locator('.swb-gear').click();
        await expect(band.locator('.swb-editor')).toBeVisible();
        await band.locator('.swb-editor input[data-k="kp"]').fill('4');
        await band.locator('.swb-editor .swb-save').click();
        await expect(band.locator('.swb-editor')).toBeHidden();
        expect(await page.evaluate(() =>
            JSON.parse(localStorage.getItem('pp-threshold-profile')).kp)).toBe(4);

        // Kp 4.5 is normally just 'elevated' — at your Kp-4 line it must
        // escalate. Quiesce feeds first (the compose-spec pattern).
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
        await page.evaluate(() => {
            let hi = setTimeout(() => {}, 0);
            for (let i = 1; i <= hi; i++) { clearTimeout(i); clearInterval(i); }
            const el = document.getElementById('kp-val');
            if (el) el.textContent = '4.5';
        });
        const kpCell = band.locator('[data-cell="kp"]');
        await expect(kpCell).toHaveClass(/warning/, { timeout: 15_000 });
        await expect(kpCell.locator('.swb-detail')).toContainText('your line (Kp 4)');
    });

    test('config sheet: gallery ⚙ applies live and persists across reload', async ({ page }) => {
        test.slow();
        await seed(page);
        await page.route(SB_REST, (r) => r.fulfill({ json: [] }));
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#lab-open', { timeout: 30_000 });
        await page.click('#lab-open');
        await page.getByRole('button', { name: /Gallery/ }).click();

        const stageRow = page.locator('#lab-gallery .lab-gallery-row[data-panel="stage"]');
        await stageRow.locator('button[title="Configure this panel"]').click();
        const sheet = page.locator('#lab-gallery .lab-config-sheet');
        await expect(sheet).toBeVisible();
        await sheet.locator('select[data-key="station"]').selectOption('orbit-ops');
        await sheet.locator('button', { hasText: 'Apply' }).click();

        // Live apply (the sw-panel-config event) + persisted store.
        await expect.poll(() => page.evaluate(() => window.__swStage?.station))
            .toBe('orbit-ops');
        expect(await page.evaluate(() =>
            JSON.parse(localStorage.getItem('pp-panel-config.space-weather')).stage.station))
            .toBe('orbit-ops');

        // Cold boot honors it (window.__swPanelConfig path).
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#sw-stage-host canvas', { timeout: 30_000 });
        await expect.poll(() => page.evaluate(() => window.__swStage?.station),
            { timeout: 20_000 }).toBe('orbit-ops');
    });

    test('multi-instance: add an aurora spot, pick a place, reload recreates it', async ({ page }) => {
        test.slow();
        await seed(page);
        await page.addInitScript(() => {
            localStorage.setItem('ppx_user_location', JSON.stringify(
                { lat: 64.84, lon: -147.72, city: 'Fairbanks' }));
        });
        await page.route(SB_REST, (r) => r.fulfill({ json: [] }));
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#lab-open', { timeout: 30_000 });
        await page.click('#lab-open');
        await page.getByRole('button', { name: /Gallery/ }).click();

        // ＋Add builds an instance from the template via the factory.
        const addRow = page.locator('#lab-gallery .lab-gallery-row',
            { hasText: 'Aurora tonight — saved spot' });
        await addRow.locator('button', { hasText: 'Add' }).click();
        const inst = page.locator('[data-lab-panel="aurora-spot#1"]');
        await expect(inst).toBeVisible();

        // Pick the pin → the card calls the verdict oracle for that spot
        // and persists the choice in the per-instance config store.
        await inst.locator('.as-loc').selectOption({ index: 1 });
        await expect(inst.locator('.as-city')).toContainText('Fairbanks');
        await expect(inst.locator('.as-verdict')).not.toHaveText('—');

        // Save → the layout doc carries the instance id.
        await page.getByRole('button', { name: /Save mine/ }).click();
        const saved = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('pp-layout.space-weather')));
        expect(saved.zones.grid.order).toContain('aurora-spot#1');

        // Cold boot: applyLayout's instantiate hook recreates the card,
        // and the config store restores its location.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#lab-open', { timeout: 30_000 });
        const inst2 = page.locator('[data-lab-panel="aurora-spot#1"]');
        await expect(inst2).toBeVisible({ timeout: 15_000 });
        await expect(inst2.locator('.as-city')).toContainText('Fairbanks');
    });

    test('cloud sync: pull → synced, Save mine pushes the {layout,config,sizes} bundle', async ({ page }) => {
        test.slow();
        const pushes = [];
        await seed(page);
        await page.route(SB_REST, (r) => {
            if (r.request().method() === 'POST') {
                pushes.push(JSON.parse(r.request().postData()));
                return r.fulfill({ status: 201, json: [] });
            }
            return r.fulfill({ json: [] });
        });
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });
        await expect.poll(() => page.evaluate(() => window.__swSync?.state),
            { timeout: 30_000 }).toBe('synced');

        await page.waitForSelector('#lab-open', { timeout: 30_000 });
        await page.click('#lab-open');
        await page.getByRole('button', { name: /Save mine/ }).click();
        await expect.poll(() => pushes.length, { timeout: 15_000 }).toBeGreaterThan(0);
        const row = pushes[0][0];
        expect(row.user_id).toBe('e2e-d2-user');
        expect(row.page).toBe('space-weather');
        expect(row.doc.layout.v).toBe(2);
        expect(row.doc).toHaveProperty('config');
        expect(row.doc).toHaveProperty('sizes');
        // The push stamped the local meta (last-write-wins anchor).
        expect(await page.evaluate(() =>
            JSON.parse(localStorage.getItem('pp-layout.space-weather.meta')).updatedAt))
            .toBeTruthy();
    });

    test('header location box: shows the stored pin, typing ↵ re-pins every consumer', async ({ page }) => {
        test.slow();
        await seed(page);
        await page.addInitScript(() => {
            localStorage.setItem('ppx_user_location', JSON.stringify(
                { lat: 64.84, lon: -147.72, city: 'Fairbanks' }));
        });
        await page.route(SB_REST, (r) => r.fulfill({ json: [] }));
        // Nominatim mock: the box geocodes through the shared helper.
        await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({
            json: [{ lat: '69.6492', lon: '18.9553',
                     display_name: 'Tromsø, Norway',
                     address: { city: 'Tromsø', country: 'Norway' } }] }));
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });

        // Boot: the stored location shows in the header, under the title.
        const box = page.locator('#sw-loc-box');
        await expect(box.locator('.swloc-input')).toHaveValue('Fairbanks', { timeout: 30_000 });
        await expect(box.locator('.swloc-coords')).toHaveText('64.8°N 147.7°W');

        // Type a new place + ↵ → geocode → saveUserLocation → the ONE
        // 'user-location-changed' dispatch re-pins the band's tonight cell.
        await box.locator('.swloc-input').fill('Tromso');
        await box.locator('.swloc-input').press('Enter');
        await expect(box.locator('.swloc-coords')).toHaveText('69.6°N 19.0°E', { timeout: 15_000 });
        expect(await page.evaluate(() =>
            JSON.parse(localStorage.getItem('ppx_user_location')).city)).toBe('Tromsø');
        await expect(page.locator('#sw-status-band [data-cell="tonight"] .swb-detail'))
            .toContainText('Tromsø', { timeout: 15_000 });
    });

    test('cloud sync honesty: free tier stays off; missing table self-disables', async ({ page }) => {
        await seed(page, { plan: 'free' });
        await page.goto('/space-weather.html', { waitUntil: 'domcontentloaded' });
        await expect.poll(() => page.evaluate(() => window.__swSync?.state),
            { timeout: 30_000 }).toBe('off:tier');

        // Basic tier, but the migration has not been applied → 404 → quiet.
        await seed(page, { plan: 'basic' });
        await page.route(SB_REST, (r) => r.fulfill({
            status: 404, json: { code: 'PGRST205', message: 'relation not found' } }));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect.poll(() => page.evaluate(() => window.__swSync?.state),
            { timeout: 30_000 }).toBe('migration-pending');
    });
});
