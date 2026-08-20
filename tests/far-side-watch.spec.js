// far-side-watch.spec.js — browser gate for the Far-Side Watch rotation
// simulation.
//
// The page runs on a labelled synthetic field when the ingestion cron has not
// populated farside_maps, so this needs no network stubbing to be
// deterministic in shape. What it pins is the SIMULATION contract:
//
//   · the clock starts at now and only moves when driven;
//   · scrubbing to a region's emergence tick makes its lead time run out;
//   · playback advances simulated time and stops on demand;
//   · the 3D view claims its canvas (a stray 2D context would silently and
//     permanently downgrade every visitor to the flat schematic).

import { test, expect } from '@playwright/test';

const ENV_NOISE = /Failed to load resource|ERR_TUNNEL|ERR_FAILED|ERR_NAME|Supabase|favicon|WebGL|THREE/;

test.describe('Far-Side Watch simulation', () => {
    let errors;

    test.beforeEach(async ({ page }) => {
        errors = [];
        page.on('console', (m) => {
            if (m.type() === 'error' && !ENV_NOISE.test(m.text())) errors.push(m.text());
        });
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.addInitScript(() => {
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch { /* ignore */ }
        });
        await page.goto('/far-side-watch.html', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('body[data-fsw-ready="true"]', { timeout: 25_000 });
    });

    test('starts at now, with the brand spelled out', async ({ page }) => {
        await expect(page.locator('nav a').first()).toBeVisible({ timeout: 15_000 });
        // "Parker" alone reads as Eugene Parker on a solar-physics page.
        await expect(page.locator('#fsw-hero p')).toContainText('Parkers Physics');
        await expect(page.locator('#fsw-hero p a')).toHaveAttribute('href', 'cme-forecast.html');

        await expect(page.locator('#fsw-sim-offset')).toHaveText('now');
        await expect(page.locator('#fsw-sim-offset')).toHaveClass(/is-now/);
        await expect(page.locator('#fsw-sim-stamp')).toContainText('UTC');
        await expect(page.locator('#fsw-l0')).toContainText('L0');

        // The clock must NOT free-run. Nothing on this page may advance
        // simulated time unless the user asks for it.
        const before = await page.textContent('#fsw-sim-stamp');
        await page.waitForTimeout(1500);
        expect(await page.textContent('#fsw-sim-stamp')).toBe(before);

        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('the scrubber indexes every tracked emergence', async ({ page }) => {
        const ticks = page.locator('#fsw-scrub-ticks .fsw-tick');
        // One "now" mark plus one per tracked region.
        await expect(ticks).not.toHaveCount(0);
        const nowTick = page.locator('#fsw-scrub-ticks .fsw-tick--now');
        await expect(nowTick).toHaveCount(1);

        // Now sits at ~20% (7 d back of a ~34 d span), NOT at the midpoint —
        // and the scale caption has to agree with the tick.
        const nowPct = await nowTick.evaluate((el) => parseFloat(el.style.left));
        expect(nowPct).toBeGreaterThan(15);
        expect(nowPct).toBeLessThan(26);
        const labelPct = await page.locator('#fsw-scrub-now')
            .evaluate((el) => parseFloat(el.style.left));
        expect(Math.abs(labelPct - nowPct)).toBeLessThan(0.5);

        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('scrubbing to an emergence tick runs that region out to the limb', async ({ page }) => {
        await expect(page.locator('#fsw-watchlist .fsw-eta').first()).toContainText('d');
        await expect(page.locator('#fsw-emerged')).toBeHidden();
        await expect(page.locator('.fsw-track--emerged')).toHaveCount(0);

        // The soonest region and its tick. Its Carrington longitude is on the
        // card; the L0 readout is in the hero. Those two numbers are what the
        // crossing claim is made of, so the check below is end-to-end: it
        // compares the rendered geometry against the rendered ephemeris.
        const lonText = await page.locator('#fsw-watchlist .fsw-track-pos').first().textContent();
        const lon = Number(lonText.match(/L(-?\d+(?:\.\d+)?)/)[1]);
        expect(Number.isFinite(lon)).toBe(true);

        const tickPct = await page.locator('#fsw-scrub-ticks .fsw-tick:not(.fsw-tick--now)')
            .first().evaluate((el) => parseFloat(el.style.left));
        expect(tickPct).toBeGreaterThan(0);

        await page.evaluate((pct) => {
            const s = document.getElementById('fsw-scrub');
            s.value = String(pct / 100);
            s.dispatchEvent(new Event('input', { bubbles: true }));
        }, tickPct);
        await expect(page.locator('#fsw-sim-offset')).not.toHaveText('now');

        // Central-meridian distance must be -90: the region is ON the east
        // limb at the instant its own tick says it arrives.
        const l0 = Number((await page.textContent('#fsw-l0')).match(/L0\s+(-?\d+(?:\.\d+)?)/)[1]);
        const cmd = ((lon - l0 + 180) % 360 + 360) % 360 - 180;
        expect(Math.abs(cmd + 90)).toBeLessThan(2.5);

        // A hair further and it has crossed. Note it re-sorts to the BOTTOM of
        // the list (emerged regions are kept, not dropped), so the first .fsw-eta
        // is now the next region — assert on the emerged marker, not on position.
        await page.evaluate((pct) => {
            const s = document.getElementById('fsw-scrub');
            s.value = String((pct + 1) / 100);
            s.dispatchEvent(new Event('input', { bubbles: true }));
        }, tickPct);
        await expect(page.locator('#fsw-emerged')).toBeVisible();
        await expect(page.locator('#fsw-emerged')).toContainText('emerged');
        await expect(page.locator('.fsw-track--emerged').first()).toContainText('Earth-facing');

        // Back to now restores the forecast.
        await page.click('#fsw-now');
        await expect(page.locator('#fsw-sim-offset')).toHaveText('now');
        await expect(page.locator('#fsw-emerged')).toBeHidden();
        await expect(page.locator('.fsw-track--emerged')).toHaveCount(0);

        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('playback advances simulated time and stops', async ({ page }) => {
        await expect(page.locator('#fsw-play')).toHaveAttribute('aria-pressed', 'false');
        await page.click('#fsw-play');
        await expect(page.locator('#fsw-play')).toHaveAttribute('aria-pressed', 'true');

        await expect(page.locator('#fsw-sim-offset')).not.toHaveText('now', { timeout: 5000 });
        await page.click('#fsw-play');
        await expect(page.locator('#fsw-play')).toHaveAttribute('aria-pressed', 'false');

        // Paused really means paused.
        const stamp = await page.textContent('#fsw-sim-stamp');
        await page.waitForTimeout(1200);
        expect(await page.textContent('#fsw-sim-stamp')).toBe(stamp);

        // Arrow keys step a quarter day without starting playback.
        await page.locator('#fsw-hero h1').click();
        await page.keyboard.press('ArrowRight');
        expect(await page.textContent('#fsw-sim-stamp')).not.toBe(stamp);
        await expect(page.locator('#fsw-play')).toHaveAttribute('aria-pressed', 'false');

        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('the sign-up gate stays inside its own box', async ({ page }) => {
        // Signed out, the watch list shows the soonest region and gates the
        // rest. The CTA used to be absolutely positioned, so whenever the
        // blurred teaser was shorter than the CTA — the common one-hidden-
        // region case — the sign-up copy landed on top of the visible card
        // and the toolbar below it.
        const gate = page.locator('.fsw-gate-inline');
        const gateCount = await gate.count();
        test.skip(gateCount === 0, 'no gated regions in this field');

        const cta = page.locator('.fsw-gate-cta');
        const [gateBox, ctaBox] = await Promise.all([
            gate.boundingBox(), cta.boundingBox(),
        ]);
        expect(ctaBox.height).toBeLessThanOrEqual(gateBox.height + 1);
        expect(ctaBox.y).toBeGreaterThanOrEqual(gateBox.y - 1);

        // And it must not sit on top of the controls underneath it.
        const btn = await page.locator('#fsw-alert-toggle').boundingBox();
        expect(ctaBox.y + ctaBox.height).toBeLessThanOrEqual(btn.y + 1);

        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('the 3D rotation view owns its canvas', async ({ page }) => {
        // A 2D context taken on #fsw-topdown before the globe mounts makes
        // WebGL permanently unavailable on that element — the fallback then
        // looks like a deliberate choice instead of a regression. Headless
        // Chromium has SwiftShader, so 3D is the expected path here.
        const kind = await page.locator('#fsw-topdown').evaluate((c) => {
            try { return c.getContext('webgl2') || c.getContext('webgl') ? '3d' : '2d'; }
            catch { return '2d'; }
        });
        expect(kind).toBe('3d');
        await expect(page.locator('.fsw-note-3d')).toContainText('simulation clock');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });
});
