/**
 * bootes-void-smoke.spec.js — browser gate for bootes-void.html.
 *
 * Run: npx playwright test tests/bootes-void-smoke.spec.js
 *
 * The static contract between the markup and js/bootes/page.js is checked by
 * `node tests/bootes-void-page.mjs`, and the physics by the two kernel gates.
 * What only a browser can check is the part in between: that the page actually
 * boots, that every readout ends up carrying a value instead of its placeholder,
 * that the canvases have paint on them, and that moving a control moves the
 * numbers it is supposed to move.
 *
 * NO NETWORK. The page fetches nothing — every input is either a literal in
 * js/bootes-void-data.js or computed — so this spec needs no route mocking and
 * must never grow any. If a future edit makes this page fetch, that is a change
 * to its provenance story and belongs in data/bootes/SOURCES.md first.
 */

import { test, expect } from '@playwright/test';

const PAGE = '/bootes-void.html';

/** Wait for the first recompute to land — the mass deficit is the last thing written. */
async function ready(page) {
    await page.waitForFunction(() => {
        const el = document.querySelector('[data-bv="massDeficit"]');
        return el && el.textContent.trim() && el.textContent.trim() !== '—';
    }, null, { timeout: 20000 });
}

test.describe('Boötes Void', () => {
    test('boots with no console errors and fills every readout', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

        await page.goto(PAGE);
        await ready(page);

        // Every data-bv element must carry a real value. An em-dash left behind
        // reads as "not available" rather than "never wired", which is the whole
        // failure mode the DOM contract exists to prevent.
        const unfilled = await page.evaluate(() => [...document.querySelectorAll('[data-bv]')]
            .filter(el => !el.textContent.trim() || el.textContent.trim() === '—')
            .map(el => el.getAttribute('data-bv')));
        expect(unfilled, 'readouts still on their placeholder').toEqual([]);

        expect(errors, 'console/page errors during boot').toEqual([]);
    });

    test('the stage renders and the fallback stays hidden', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);

        const stage = page.locator('#bv-stage');
        await expect(stage).toBeVisible();

        // The fallback must be BOTH hidden-attributed and computed display:none.
        // An author `display:flex` on an id beats the UA sheet's
        // [hidden]{display:none}, and the message rendered straight through a
        // working canvas until the explicit rule was added. Checking `.hidden`
        // alone would have passed on the broken build.
        const fb = await page.evaluate(() => {
            const el = document.querySelector('#bv-stage-fallback');
            return { hidden: el.hidden, display: getComputedStyle(el).display };
        });
        expect(fb.hidden).toBe(true);
        expect(fb.display, 'the [hidden] rule must actually take effect').toBe('none');

        // The GL context exists and the canvas has non-zero size.
        const gl = await page.evaluate(() => {
            const c = document.querySelector('#bv-stage');
            return { w: c.width, h: c.height, ctx: !!(c.getContext('webgl2') || c.getContext('webgl')) };
        });
        expect(gl.ctx).toBe(true);
        expect(gl.w).toBeGreaterThan(100);
        expect(gl.h).toBeGreaterThan(100);
    });

    test('every figure has paint on it', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        const painted = await page.evaluate(() =>
            [...document.querySelectorAll('[data-bv-chart]')].map(c => {
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                let n = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
                return { key: c.getAttribute('data-bv-chart'), pixels: n };
            }));
        expect(painted.length).toBeGreaterThanOrEqual(7);
        for (const chart of painted) {
            // A frame alone is roughly 2k pixels; a real curve is well above it.
            expect(chart.pixels, `chart "${chart.key}" is blank`).toBeGreaterThan(2500);
        }
    });

    test('the bias slider moves the whole chain at once', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);

        const snapshot = () => page.evaluate(() => ({
            deltaM: document.querySelector('[data-bv="deltaMCore"]').textContent,
            peak: document.querySelector('[data-bv="peakOutflow"]').textContent,
            mass: document.querySelector('[data-bv="massDeficit"]').textContent,
            isw: document.querySelector('[data-bv="iswCentral"]').textContent,
            snr: document.querySelector('[data-bv="lensingSnr"]').textContent,
        }));
        const before = await snapshot();

        // A LOWER bias means a DEEPER matter void, so every downstream amplitude
        // must grow. That coupling is the point of the control — this asserts
        // the whole chain moved together, which is what one shared recompute
        // buys and what per-panel incremental updates would break.
        await page.locator('[data-bv-control="bias"]').fill('1.15');
        await page.locator('[data-bv-control="bias"]').dispatchEvent('input');
        await page.waitForTimeout(900);
        const after = await snapshot();

        expect(after.deltaM).not.toBe(before.deltaM);
        expect(after.peak).not.toBe(before.peak);
        expect(after.mass).not.toBe(before.mass);
        expect(after.isw).not.toBe(before.isw);

        const f = (s) => parseFloat(String(s).replace(/[^\d.\-]/g, ''));
        expect(Math.abs(f(after.deltaM)), 'a lower bias deepens the matter void')
            .toBeGreaterThan(Math.abs(f(before.deltaM)));
        expect(f(after.peak), 'and speeds up the outflow').toBeGreaterThan(f(before.peak));
        expect(Math.abs(f(after.isw)), 'and deepens the ISW cold spot')
            .toBeGreaterThan(Math.abs(f(before.isw)));
    });

    test('the physical signs the page argues for survive a round trip', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        const signs = await page.evaluate(() => ({
            isw: document.querySelector('[data-bv="iswSign"]').textContent,
            outflow: document.querySelector('[data-bv="peakOutflow"]').textContent,
            mass: document.querySelector('[data-bv="massDeficit"]').textContent,
            compensation: document.querySelector('[data-bv="compensation"]').textContent,
            tidal: document.querySelector('[data-bv="tidalReading"]').textContent,
        }));
        expect(signs.isw, 'a void prints a COLD spot').toContain('COLD');
        expect(signs.mass, 'the enclosed mass is a deficit').toContain('-');
        expect(parseFloat(signs.outflow), 'the outflow is outward and substantial')
            .toBeGreaterThan(50);
        expect(parseFloat(signs.compensation), 'the void is under-compensated').toBeLessThan(1);
        expect(signs.tidal).toContain('squeezed into the wall');
    });

    test('the field mode switches without recomputing the physics', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);

        const modeLabel = page.locator('[data-bv="fieldMode"]').first();
        await expect(modeLabel).toContainText('Δg');

        // `.first()` is required, not defensive: massDeficit deliberately
        // appears twice in the markup (headline strip and compensation card),
        // and a bare locator is a strict-mode violation on exactly the keys the
        // page repeats on purpose.
        const massBefore = await page.locator('[data-bv="massDeficit"]').first().textContent();
        await page.locator('[data-bv-control="mode"]').selectOption('velocity');
        await page.waitForTimeout(400);
        await expect(modeLabel).toContainText('Peculiar velocity');
        await expect(page.locator('[data-bv="fieldMax"]').first()).toContainText('km/s');

        // Switching what is DRAWN must not change what is COMPUTED.
        expect(await page.locator('[data-bv="massDeficit"]').first().textContent())
            .toBe(massBefore);
    });

    test('re-rolling the web changes the model but not the void', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        const before = await page.evaluate(() => ({
            seed: document.querySelector('[data-bv="seed"]').textContent,
            mass: document.querySelector('[data-bv="massDeficit"]').textContent,
            horizon: document.querySelector('[data-bv="velocityHorizon"]').textContent,
            share: document.querySelector('[data-bv="shareAtTwo"]').textContent,
        }));
        await page.locator('#bv-reroll').click();
        await page.waitForTimeout(900);
        const after = await page.evaluate(() => ({
            seed: document.querySelector('[data-bv="seed"]').textContent,
            mass: document.querySelector('[data-bv="massDeficit"]').textContent,
            horizon: document.querySelector('[data-bv="velocityHorizon"]').textContent,
            share: document.querySelector('[data-bv="shareAtTwo"]').textContent,
        }));

        expect(after.seed).not.toBe(before.seed);
        // The void's own quantities depend on the profile alone, so a different
        // web must leave them untouched. If they move, something has leaked
        // between the two halves of the counterfactual.
        expect(after.mass, 'the mass deficit belongs to the void, not the web')
            .toBe(before.mass);
        expect(after.horizon, 'the velocity horizon belongs to the void, not the web')
            .toBe(before.horizon);
    });

    test('the provenance banner is present and cannot be dismissed', async ({ page }) => {
        await page.goto(PAGE);
        const banner = page.locator('.bv-provenance');
        await expect(banner).toBeVisible();
        await expect(banner).toContainText('Everything else on this page is a model');
        await expect(banner).toContainText('No number here is a detection');
        // No close affordance of any kind.
        expect(await banner.locator('button, [role="button"], a[href="#"]').count()).toBe(0);
    });

    test('the page is reachable from the Deep Space menu', async ({ page }) => {
        await page.goto('/deep-space.html');
        await expect(page.locator('a[href="bootes-void.html"]').first()).toBeVisible();
    });
});
