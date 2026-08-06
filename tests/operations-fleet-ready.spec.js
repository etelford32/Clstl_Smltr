import { test, expect } from '@playwright/test';

test.describe('Orbit Margin fleet-ready flow', () => {
    test('operator brief launches the demo and import workflows', async ({ page }) => {
        await page.goto('/for-operators.html', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('h1')).toContainText(/stress-test your fleet/i);
        await expect(page.locator('a[data-funnel-cta="operators_demo_fleet"]'))
            .toHaveAttribute('href', /operations\.html\?fleet=demo&storm=gannon/);
        await expect(page.locator('a[data-funnel-cta="operators_import_fleet"]'))
            .toHaveAttribute('href', /operations\.html\?fleet=import/);
        await expect(page.locator('#workflow')).toContainText(/load the fleet/i);
        await expect(page.locator('#assessment')).toContainText(/storm-readiness assessment/i);
    });

    test('fleet import accepts CSV and briefing export downloads', async ({ page }) => {
        // Fleet intake and report generation must remain usable even if public
        // TLE relays are unavailable. The rows settle to unresolved, while the
        // imported IDs and explicit limitations still export.
        await page.route('**/api/celestrak/**', route => route.abort());
        await page.route('**/celestrak.org/**', route => route.abort());
        await page.goto('/operations.html?fleet=import', { waitUntil: 'domcontentloaded' });

        await expect(page.locator('#op-fleet-import')).toHaveAttribute('open', '', { timeout: 20_000 });
        await page.fill('#op-fleet-import-text', 'norad_id,name,altitude_km\n25544,ISS,420\n20580,Hubble,540');
        await page.click('#op-fleet-import-btn');

        await expect(page.locator('#op-fleet-count')).toHaveText('2 / 10 assets', { timeout: 20_000 });
        await expect(page.locator('#op-fleet-list .op-fleet-row')).toHaveCount(2);

        const downloadPromise = page.waitForEvent('download');
        await page.click('#op-export-fleet-csv');
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toMatch(/^orbit-margin-fleet-[a-f0-9]{8}\.csv$/);
    });

    test('demo handoff selects the Gannon scenario', async ({ page }) => {
        await page.route('**/api/celestrak/**', route => route.abort());
        await page.route('**/celestrak.org/**', route => route.abort());
        await page.goto('/operations.html?fleet=demo&storm=gannon', { waitUntil: 'domcontentloaded' });

        await expect(page.locator('.op-sw-scn[data-scn="gannon"]'))
            .toHaveClass(/op-sw-scn--on/, { timeout: 20_000 });
        await expect(page.locator('#op-fleet-count')).not.toHaveText('0 / 10 assets', { timeout: 20_000 });
    });

    test('catalogue health reports OMM freshness, extended IDs, and partial coverage', async ({ page }) => {
        const omm = (noradId, name) => ({
            name, norad_id: noradId, source_format: 'omm-json',
            line1: null, line2: null,
            epoch: '2026-08-06T06:00:00.000Z', epoch_ms: Date.parse('2026-08-06T06:00:00.000Z'),
            epoch_jd: Date.parse('2026-08-06T06:00:00.000Z') / 86400000 + 2440587.5,
            inclination: 51.64, raan: 120, eccentricity: 0.0007,
            arg_perigee: 40, mean_anomaly: 30, mean_motion: 15.5,
            bstar: 0.00012, rev_at_epoch: 1,
            period_min: 92.9, apogee_km: 422, perigee_km: 412,
        });
        await page.route('**/api/celestrak/**', async route => {
            const url = new URL(route.request().url());
            const group = url.searchParams.get('group');
            const satellite = group === 'debris'
                ? omm(100147, 'EXTENDED ID DEBRIS')
                : group === 'stations' ? omm(25544, 'ISS') : null;
            const isPartial = group === 'debris';
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    source: 'CelesTrak GP / OMM', source_format: 'omm-json',
                    satellites: satellite ? [satellite] : [],
                    upstream_count: satellite ? 1 : 0, rejected_count: 0,
                    update_cadence_hours: 2, fetched: '2026-08-06T06:05:00.000Z',
                    subgroups: isPartial ? [
                        { group: 'fengyun-1c-debris', status: 'ok' },
                        { group: 'cosmos-1408-debris', status: 'error', error: 'fixture outage' },
                    ] : null,
                }),
            });
        });
        await page.route('**/celestrak.org/**', route => route.abort());
        await page.goto('/operations.html', { waitUntil: 'domcontentloaded' });

        await expect(page.locator('#op-catalog-health .op-cat-head')).toHaveClass(/op-cat-head--partial/, { timeout: 20_000 });
        await expect(page.locator('#op-catalog-health')).toContainText('OMM');
        await expect(page.locator('#op-catalog-health')).toContainText('100,147');
        await expect(page.locator('#op-catalog-health')).toContainText(/not full public-catalogue/i);
        await expect.poll(() => page.evaluate(() => window.__op.catalogHealth.snapshot())).toMatchObject({
            state: 'partial',
            loadedCount: 2,
            sixPlusDigitCount: 1,
            subgroupFailures: 1,
            scope: 'selected-layers',
        });
    });

    test('risk outlook and vehicle lab compare designs, actions, and thruster state', async ({ page }) => {
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        const iss = {
            name: 'ISS (ZARYA)', norad_id: 25544,
            line1: '1 25544U 98067A   26217.50000000  .00012000  00000+0  22000-3 0  9991',
            line2: '2 25544  51.6400 120.0000 0007000  40.0000  30.0000 15.50000000400001',
            epoch: '2026-08-05T12:00:00.000Z', inclination: 51.64,
            period_min: 92.9, apogee_km: 422, perigee_km: 412,
        };
        await page.route('**/api/celestrak/**', async route => {
            const url = new URL(route.request().url());
            const body = url.searchParams.get('norad') === '25544' ? [iss] : [];
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ satellites: body }),
            });
        });
        await page.route('**/celestrak.org/**', route => route.abort());
        await page.goto('/operations.html?fleet=import', { waitUntil: 'domcontentloaded' });
        await page.fill('#op-fleet-import-text', '25544');
        await page.click('#op-fleet-import-btn');

        await expect(page.locator('#op-risk-outlook .op-risk-alt-row')).toHaveCount(1, { timeout: 20_000 });
        await expect(page.locator('#op-risk-outlook')).toContainText('Perigee outlook');
        await expect(page.locator('#op-risk-outlook .op-risk-alt-head')).toContainText('72h');
        await expect(page.locator('#op-risk-outlook')).toContainText('collision screening is not Pc');
        await expect(page.locator('#op-risk-outlook .op-risk-alt-row')).toHaveAttribute('title', /drag vs quiet/);

        await page.click('#op-fleet-list .op-fleet-row[data-norad="25544"]');
        await expect(page.locator('#op-vehicle-lab-body .op-veh-branch')).toHaveCount(5);
        await expect(page.locator('#op-vehicle-lab-body')).toContainText('72-hour action comparison');
        await page.selectOption('#op-veh-profile', 'flat-electric');
        await expect(page.locator('#op-veh-profile')).toHaveValue('flat-electric');

        await page.click('.op-veh-assumptions summary');
        await page.fill('#op-veh-mass', '900');
        await page.fill('#op-veh-thrust', '0.2');
        await page.click('#op-veh-apply');
        await expect(page.locator('#op-vehicle-lab-body .op-veh-bc')).toContainText('9.78e-3', { timeout: 10_000 });

        await page.click('[data-veh-action="low-drag"]');
        await expect(page.locator('[data-veh-action="low-drag"]')).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => page.evaluate(() => window.__op.focusMesh.getVisualState().attitude)).toBe('low-drag');

        await page.click('[data-veh-action="maneuver"]');
        await expect(page.locator('[data-veh-action="maneuver"]')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#op-mvr-dvT')).toHaveValue('1');
        await expect.poll(() => page.evaluate(() => window.__op.focusMesh.getVisualState())).toMatchObject({
            selectedNoradId: 25544,
            kind: 'vehicle-design',
            profileId: 'flat-electric',
            activeAction: 'maneuver',
            plumeCount: 1,
        });
        expect(pageErrors).toEqual([]);
        const vehicleVisual = await page.evaluate(() => window.__op.focusMesh.getVisualState());
        expect(vehicleVisual).toMatchObject({
            selectedNoradId: 25544,
            kind: 'vehicle-design',
            profileId: 'flat-electric',
            activeAction: 'maneuver',
        });
        expect(vehicleVisual.plumeCount).toBeGreaterThan(0);
    });

    test('assessment handoff tags the operator request', async ({ page }) => {
        await page.goto('/request-access.html?use_case=fleet_assessment', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('input[value="satellite_operations"]')).toBeChecked();
        await expect(page.locator('#ra-submit')).toHaveText(/request fleet assessment/i);
        await expect(page.locator('#ra-message')).toHaveAttribute('placeholder', /decision to rehearse/i);
    });
});
