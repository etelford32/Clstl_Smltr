/**
 * simulations-catalog.spec.js — the catalog page must be complete, reachable
 * and static.
 *
 * tests/simulations-catalog.mjs gates the DATA (every page classified, the
 * markup in sync with js/simulations-catalog.js). This spec gates the three
 * things only a browser can answer:
 *
 *   1. The grid is really 3 across on desktop and collapses to 1 on mobile.
 *   2. The cards are SERVER-RENDERED. The page is the site's index, so it has
 *      to survive JavaScript being off — a client-rendered grid would hand
 *      crawlers an empty <main> and nobody would notice for months. The
 *      javaScriptEnabled:false context is the whole point of this file.
 *   3. The nav's top-level "Simulations" item exists, reaches the page, and
 *      lights up as active once there.
 *
 * Plus the filter, which is progressive enhancement layered on (1)+(2).
 *
 * No network needed — the page ships no feeds.
 */
import { test, expect } from '@playwright/test';

const EXPECTED_SECTIONS = 8;

test.describe('simulations catalog', () => {
    test('renders a 3-column grid of every simulation', async ({ page }) => {
        await page.goto('/simulations.html', { waitUntil: 'load' });
        await page.waitForSelector('.sim-card');

        const cards = await page.locator('.sim-card').count();
        expect(cards).toBeGreaterThanOrEqual(50);
        expect(await page.locator('.sim-section').count()).toBe(EXPECTED_SECTIONS);

        // The headline quotes the catalog size; it must match what rendered.
        await expect(page.locator('.sim-hero h1')).toHaveText(`${cards} simulations. One engine.`);

        // Every card is a real link to a real page, with a title and a blurb.
        const shape = await page.evaluate(() => {
            const bad = [];
            for (const card of document.querySelectorAll('.sim-card')) {
                const href = card.getAttribute('href') || '';
                const title = card.querySelector('.sim-card-title')?.textContent?.trim() || '';
                const blurb = card.querySelector('.sim-card-blurb')?.textContent?.trim() || '';
                if (!/^[a-z0-9-]+\.html$/.test(href) || !title || !blurb) bad.push(href || '(no href)');
            }
            return bad;
        });
        expect(shape).toEqual([]);

        const columns = async () => page.evaluate(() =>
            getComputedStyle(document.querySelector('.sim-grid')).gridTemplateColumns.split(' ').length);

        await page.setViewportSize({ width: 1440, height: 900 });
        expect(await columns()).toBe(3);
        await page.setViewportSize({ width: 820, height: 900 });
        expect(await columns()).toBe(2);
        await page.setViewportSize({ width: 480, height: 900 });
        expect(await columns()).toBe(1);
    });

    test('the grid is server-rendered — it survives JavaScript being off', async ({ browser }) => {
        const context = await browser.newContext({ javaScriptEnabled: false });
        const page = await context.newPage();
        await page.goto('/simulations.html', { waitUntil: 'domcontentloaded' });

        // No nav (it mounts from js/nav.js) but the catalog itself must be there.
        expect(await page.locator('.sim-card').count()).toBeGreaterThanOrEqual(50);
        await expect(page.locator('a.sim-card[href="earth.html"]')).toHaveCount(1);
        await context.close();
    });

    test('filter narrows cards and hides emptied sections', async ({ page }) => {
        await page.goto('/simulations.html', { waitUntil: 'load' });
        await page.waitForSelector('.sim-card');
        const total = await page.locator('.sim-card').count();

        const visible = () => page.locator('.sim-card:not([hidden])').count();
        const liveSections = () => page.locator('.sim-section:not([hidden])').count();

        await page.fill('#sim-search', 'aurora');
        await expect.poll(visible).toBeGreaterThan(0);
        expect(await visible()).toBeLessThan(total);
        expect(await liveSections()).toBeLessThan(EXPECTED_SECTIONS);

        // A category chip filters to exactly that section.
        await page.fill('#sim-search', '');
        await page.click('[data-chip="black-holes"]');
        expect(await liveSections()).toBe(1);
        await expect(page.locator('.sim-section[data-section="black-holes"]')).toBeVisible();

        // No match → the empty state, and reset restores everything.
        await page.fill('#sim-search', 'qqqzzz');
        await expect(page.locator('#sim-empty')).toBeVisible();
        await page.click('#sim-reset');
        await expect.poll(visible).toBe(total);
        await expect(page.locator('#sim-empty')).toBeHidden();
    });

    test('the nav reaches the catalog and marks it active', async ({ page }) => {
        await page.goto('/index.html', { waitUntil: 'load' });
        const link = page.locator('nav a.nav-item[href="/simulations.html"]');
        await expect(link).toHaveCount(1);
        await expect(link).toHaveText('Simulations');

        await link.click();
        await page.waitForURL('**/simulations.html');
        await expect(page.locator('nav a.nav-item[href="/simulations.html"]')).toHaveClass(/active/);
    });

    test('the nav bar keeps Sign Up on-screen at common desktop widths', async ({ page }) => {
        // Regression gate for the 2026-08 measurement: the bar is
        // flex-wrap:nowrap over a body that does not scroll horizontally, so
        // anything past the right edge is UNREACHABLE, not merely clipped. The
        // 320px PRO promo used to hold its full width down to 1280px and push
        // "Sign Up Free" off-screen at 1440. See the note on the 1700px
        // breakpoint in js/nav-styles.css.
        await page.goto('/simulations.html', { waitUntil: 'load' });
        await page.waitForSelector('.nav-signup');

        for (const width of [1440, 1600, 1920]) {
            await page.setViewportSize({ width, height: 900 });
            const right = await page.evaluate(() =>
                document.querySelector('.nav-signup').getBoundingClientRect().right);
            expect(right, `Sign Up is off-screen at ${width}px`).toBeLessThanOrEqual(width);
        }
    });
});
