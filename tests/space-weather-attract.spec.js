// space-weather-attract.spec.js — browser gate for the S3/D4 attract
// loop (plan decision #6): the Stage IS the ?preview=1 surface, runs the
// station auto-flight with the persona-moment tagline, and the three
// public touchpoints (signin backdrop, landing section, pricing hero)
// carry the lazy embed. All offline-safe.

import { test, expect } from '@playwright/test';

test.describe('attract loop (S3/D4)', () => {

    test('?preview=1 promotes the Stage and runs the cinematic', async ({ page }) => {
        test.slow();
        await page.route('**/services.swpc.noaa.gov/**', (r) => r.abort());
        await page.goto('/space-weather.html?preview=1', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('html')).toHaveAttribute('data-preview', '1');
        // The Stage is the promoted preview surface now.
        await expect(page.locator('.stage-section')).toHaveClass(/preview-stage/, { timeout: 30_000 });
        await expect(page.locator('#sw-stage-host canvas')).toBeVisible({ timeout: 30_000 });
        await expect.poll(() => page.evaluate(() => window.__swStage?.attract),
            { timeout: 30_000 }).toBe(true);
        // Interactive chrome is gone; the tagline element is armed.
        await expect(page.locator('.swst-stations')).toBeHidden();
        await expect(page.locator('.swst-tau')).toBeHidden();
        await expect(page.locator('.swst-tagline')).toBeAttached();
        // The auto-flight cycles stations (7 s cadence — generous poll for
        // software-GL CI; frame-rate-independence lesson).
        await expect.poll(() => page.evaluate(() => window.__swStage?.station),
            { timeout: 45_000 }).not.toBe('corridor');
    });

    test('signin gate carries the backdrop embed behind the auth card', async ({ page }) => {
        await page.goto('/signin.html', { waitUntil: 'domcontentloaded' });
        const backdrop = page.locator('#sw-attract-backdrop');
        await expect(backdrop).toBeAttached();
        await expect(backdrop.locator('iframe')).toHaveAttribute('src', /preview=1/);
        expect(await backdrop.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
        // The form stays fully usable above it.
        await expect(page.locator('#email')).toBeVisible();
    });

    test('landing and pricing heroes carry the lazy embed + CTAs', async ({ page }) => {
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        const section = page.locator('.sw-attract-section');
        await expect(section).toBeAttached();
        await expect(section.locator('iframe.sw-attract-frame')).toHaveAttribute('loading', 'lazy');
        await expect(section.locator('a[href="request-access.html"]')).toBeAttached();
        await expect(section).toContainText('Where will it be when it reaches you?');

        await page.goto('/pricing.html', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.pricing-hero iframe.sw-attract-frame'))
            .toHaveAttribute('src', /preview=1/);
    });
});
