/**
 * storm-watch-visibility.spec.js — the storm watch panel must be FINDABLE.
 *
 * Regression gate for the 2026-08 "storm watch panel not showing up at
 * all" report. The panel itself had mounted fine all along — it was
 * buried: the verdict card (z70, 400px wide, and by now taller than the
 * whole panel) sat directly on top of the panel's home position (z60,
 * same corner), leaving a ~60px header sliver as the only evidence the
 * panel existed. On mobile the panel's mount-time injected stylesheet
 * beat the page's bottom-sheet rules on cascade order, rendering the
 * sheet as a narrow floating column that also peeked while "closed".
 *
 * Three pins:
 *   1. Desktop + active verdict card → the panel's home is BESIDE the
 *      card, and its header actually receives hits (not occluded).
 *   2. Grabbing a panel raises it above the verdict card's z70
 *      (raise-on-grab), so a stacked panel can always be surfaced.
 *   3. Mobile → closed sheet fully off-screen; dock button opens a
 *      full-width sheet on-screen.
 *
 * No live network needed — the panel renders its empty state without
 * feeds, and these tests only assert chrome geometry.
 */
import { test, expect } from '@playwright/test';

const PANEL = '#storm-watch-panel';

test.describe('storm watch panel visibility', () => {
    test('desktop: panel homes beside the active verdict card and is hittable', async ({ page }) => {
        await page.goto('/earth.html', { waitUntil: 'load' });
        await page.waitForSelector(PANEL, { timeout: 30_000 });
        // Wait for the verdict card boot (adds body.ev-verdict-solo).
        await page.waitForSelector('body.ev-verdict-solo', { timeout: 30_000 });

        const probe = await page.evaluate(() => {
            const panel = document.getElementById('storm-watch-panel');
            const card  = document.getElementById('ev-verdict-card');
            const p = panel.getBoundingClientRect();
            const c = card ? card.getBoundingClientRect() : null;
            const header = panel.querySelector('.panel-header');
            const h = header.getBoundingClientRect();
            const hit = document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2);
            return {
                panelLeft: p.left, panelTop: p.top,
                cardRight: c ? c.right : null,
                headerHitsPanel: panel.contains(hit),
            };
        });

        // Beside, not under: panel's left edge clears the card's right edge.
        expect(probe.cardRight).not.toBeNull();
        expect(probe.panelLeft).toBeGreaterThanOrEqual(probe.cardRight - 1);
        // And the header is genuinely interactive (nothing painted on top).
        expect(probe.headerHitsPanel).toBe(true);
    });

    test('desktop: grabbing the storm panel raises it above the verdict card', async ({ page }) => {
        await page.goto('/earth.html', { waitUntil: 'load' });
        await page.waitForSelector(PANEL, { timeout: 30_000 });
        await page.waitForSelector('body.ev-verdict-solo', { timeout: 30_000 });

        const zBefore = await page.$eval(PANEL, el => getComputedStyle(el).zIndex);
        expect(Number(zBefore)).toBeLessThan(70);   // default: below the card

        await page.dispatchEvent(`${PANEL} .panel-header`, 'pointerdown', {
            pointerId: 1, button: 0, clientX: 20, clientY: 20,
        });
        const zAfter = await page.$eval(PANEL, el => Number(getComputedStyle(el).zIndex));
        expect(zAfter).toBeGreaterThan(70);         // raised above the card…
        expect(zAfter).toBeLessThan(90);            // …but below tooltips/popups
    });

    test('mobile: sheet is fully hidden until the dock button opens it full-width', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/earth.html', { waitUntil: 'load' });
        await page.waitForSelector(PANEL, { timeout: 30_000 });
        // Give the sheet transition CSS a beat to settle.
        await page.waitForTimeout(400);

        const closed = await page.$eval(PANEL, el => {
            const r = el.getBoundingClientRect();
            return { top: r.top, vh: window.innerHeight };
        });
        expect(closed.top).toBeGreaterThanOrEqual(closed.vh);   // fully off-screen

        await page.click('.mtb-btn[data-panel="storm-watch-panel"]');
        await page.waitForTimeout(400);   // slide-up transition

        const open = await page.$eval(PANEL, el => {
            const r = el.getBoundingClientRect();
            return { top: r.top, width: r.width, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
        });
        expect(open.width).toBeGreaterThanOrEqual(open.vw * 0.96);  // full-width sheet
        expect(open.top).toBeLessThan(open.vh);                     // on-screen
        expect(open.bottom).toBeLessThanOrEqual(open.vh);           // docked above the toolbar
    });

    test('mobile: a stale desktop drag position cannot break the sheet', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.addInitScript(() => {
            localStorage.setItem('earth-panel-pos-storm-watch-panel',
                JSON.stringify({ left: 900, top: 400 }));
        });
        await page.goto('/earth.html', { waitUntil: 'load' });
        await page.waitForSelector(PANEL, { timeout: 30_000 });
        await page.waitForTimeout(400);

        await page.click('.mtb-btn[data-panel="storm-watch-panel"]');
        await page.waitForTimeout(400);

        const open = await page.$eval(PANEL, el => {
            const r = el.getBoundingClientRect();
            return { left: r.left, width: r.width, vw: window.innerWidth };
        });
        // The !important sheet rules must beat the persisted inline position.
        expect(open.left).toBeLessThanOrEqual(1);
        expect(open.width).toBeGreaterThanOrEqual(open.vw * 0.96);
    });
});
