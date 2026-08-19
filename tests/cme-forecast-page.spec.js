// cme-forecast-page.spec.js — deterministic browser gate for the public
// issue-time forecast surface. The route is mocked so the test asserts the
// page contract without depending on Supabase, NOAA, or wall-clock events.

import { test, expect } from '@playwright/test';

const ENV_NOISE = /Failed to load resource|ERR_TUNNEL|ERR_FAILED|ERR_NAME|Supabase|favicon/;

test.describe('CME Forecast public page', () => {
    let errors;

    test.beforeEach(async ({ page }) => {
        errors = [];
        page.on('console', (message) => {
            if (message.type() === 'error' && !ENV_NOISE.test(message.text())) errors.push(message.text());
        });
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.addInitScript(() => {
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch { /* ignore */ }
        });
    });

    test('renders locked windows, live stats, skill, and navigation', async ({ page }) => {
        const now = Date.now();
        const iso = (hours) => new Date(now + hours * 3600e3).toISOString();
        await page.route('**/api/cme/skill**', (route) => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ data: {
                updated: iso(-.25),
                models: [
                    { model_id: 'flux-rope-v1', is_hindcast: false, n_scored: 5, mae_hours: 7.6, bias_hours: -1.4, hits_12h: 4 },
                    { model_id: 'dbm-v1', is_hindcast: false, n_scored: 12, mae_hours: 10.2, bias_hours: 2.3, hits_12h: 7 },
                ],
                events: [
                    {
                        event_id: 'PP-LIVE-X12', donki_id: '2026-08-19T12:00-CME-001', launch: iso(-15), speed_kms: 1180,
                        forecasts: { 'flux-rope-v1': {
                            issued_at: iso(-14.5), predicted: iso(31), early: iso(24), late: iso(39),
                            p_hit: .82, p10: .63, p20: .36, min_bz_p50: -17, min_bz_p5: -34, n_train: 2,
                            flare: { class: 'X1.2', region: 14126 },
                        } },
                        truth: null,
                    },
                    {
                        event_id: 'PP-SCORED-M84', donki_id: '2026-08-12T05:00-CME-004', launch: iso(-180), speed_kms: 840,
                        forecasts: { 'flux-rope-v1': {
                            issued_at: iso(-179), predicted: iso(-128), early: iso(-136), late: iso(-120),
                            p_hit: .71, min_bz_p50: -11, min_bz_p5: -24,
                            flare: { class: 'M8.4', region: 14111 },
                        } },
                        truth: { arrived: true, shock: iso(-130), min_bz_nt: -14, v_kms: 690 },
                    },
                ],
            } }),
        }));

        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });

        await expect(page.locator('nav a').first()).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('h1')).toContainText('CME');
        await expect(page.locator('#cmef-feed-label')).toContainText('Issue-time ledger');
        await expect(page.locator('#cmef-active-count')).toHaveText('1');
        await expect(page.locator('#cmef-next-phit')).toHaveText('82%');
        await expect(page.locator('#cmef-bz')).toHaveText('-17 nT');
        await expect(page.locator('#cmef-event-list .cmef-event-card')).toHaveCount(2);
        await expect(page.locator('#cmef-event-list')).toContainText('X1.2 · AR14126');
        await expect(page.locator('#cmef-event-list')).toContainText('Outcome pending · forecast remains locked');
        await expect(page.locator('#cmef-event-list')).toContainText('error +2.0 h');
        await expect(page.locator('#cmef-skill-grid')).toContainText('7.6 h');
        await expect(page.locator('#cmef-timeline')).toHaveAttribute('data-ready', 'true');
        await expect(page.locator('#cmef-calendar-grid .cmef-day')).toHaveCount(7);
        await expect(page.locator('#cmef-calendar-detail')).toContainText('X1.2 · AR14126');
        await expect(page.locator('#cmef-calendar-detail')).toContainText('P(Bz ≤ −20)');

        const openDay = page.locator('#cmef-calendar-grid .cmef-day[aria-expanded="true"]');
        await expect(openDay).toHaveCount(1);
        await openDay.click();
        await expect(page.locator('#cmef-calendar-detail')).toBeHidden();

        await page.locator('[data-cmef-range="30d"]').click();
        await expect(page.locator('[data-cmef-range="30d"]')).toHaveAttribute('aria-pressed', 'true');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('fails visibly when the ledger is unavailable', async ({ page }) => {
        await page.route('**/api/cme/skill**', (route) => route.abort());
        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });

        await expect(page.locator('#cmef-feed-label')).toHaveText('Forecast ledger unavailable');
        await expect(page.locator('#cmef-event-list')).toContainText('No forecast records available');
        await expect(page.locator('#cmef-event-list')).toContainText('does not manufacture demo arrivals');
        await expect(page.locator('#cmef-timeline')).toHaveAttribute('data-ready', 'true');
        await expect(page.locator('#cmef-calendar-grid .cmef-day')).toHaveCount(7);
        await expect(page.locator('#cmef-calendar-detail')).toContainText('No issue-locked CME arrival window');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });
});
