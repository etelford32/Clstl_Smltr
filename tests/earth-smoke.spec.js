/**
 * earth-smoke.spec.js — smoke test for earth.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Boots the page in headless Chromium via the dev server, waits for scene
 * init, and verifies the key invariants that have regressed in the past:
 *
 *   1. No console errors during boot.
 *   2. Every `input[id^="lyr-"]` toggles its paired mesh.visible predictably
 *      (no silent "NASA overlay visible while checkbox off" state drift).
 *   3. Every feed that emits a status reaches a non-idle state within the
 *      boot window — any feed still on 'idle' after 15 s is probably wedged.
 *   4. The scene sustains ≥ 25 fps over a 2 s sample under default load.
 *
 * Runs via `npx playwright test tests/earth-smoke.spec.js`. CI would point
 * TEST_BASE_URL at a preview deploy; local runs against the dev server
 * spun up by playwright.config.js.
 *
 * The tests lean heavily on the `?debug=1` overlay introduced in PR C —
 * its layerRegistry + feed rollup are exactly the bus we want to assert on.
 */

import { test, expect } from '@playwright/test';

const EARTH_URL = '/earth.html?debug=1';
const BOOT_TIMEOUT_MS = 20_000;

/** Collect console errors (but not warnings — Firefox texSubImage deprecation etc.). */
function attachConsoleRecorder(page) {
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') {
            errors.push({ text: msg.text(), location: msg.location() });
        }
    });
    page.on('pageerror', (err) => {
        errors.push({ text: err.message, stack: err.stack });
    });
    return errors;
}

/** Wait for the scene's animate loop to have run at least N frames — simple
 *  proxy that earth.html has finished synchronous module init. */
async function waitForSceneReady(page) {
    await page.waitForFunction(() => {
        // The debug overlay is the easiest "scene is live" probe we have
        // without piercing the module's closure.
        return document.getElementById('debug-overlay') != null
            && document.getElementById('dbg-fps')?.textContent !== '—';
    }, { timeout: BOOT_TIMEOUT_MS });
}

test.describe('earth.html smoke', () => {

    test('boots without console errors', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(EARTH_URL);
        await waitForSceneReady(page);
        // Give a few seconds for any async init (WASM SGP4, Supabase auth)
        // to surface errors — many modules fetch in the background.
        await page.waitForTimeout(3_000);
        if (errors.length) {
            console.error('Console errors captured:', errors);
        }
        expect(errors, 'No console errors during boot').toHaveLength(0);
    });

    test('layer toggles round-trip mesh.visible', async ({ page }) => {
        await page.goto(EARTH_URL);
        await waitForSceneReady(page);
        await page.waitForTimeout(1_500);  // let ObsOverlay meshes build

        // Sample a representative set of toggles — not every layer, but
        // the ones that historically regressed. Grid / tropics / lights
        // exercise the shader-side visibility path; clouds + obs exercise
        // the mesh-side; subsolar exercises a lazy-built marker.
        const toggles = ['lyr-grid', 'lyr-tropic', 'lyr-lights',
                         'lyr-clouds', 'lyr-subsolar',
                         'lyr-obs-precip-rate'];

        for (const id of toggles) {
            const cb = page.locator(`#${id}`);
            await expect(cb, `${id} checkbox exists`).toBeVisible();

            // Start state recorded, then flip, then flip back.
            const initial = await cb.isChecked();
            await cb.setChecked(!initial, { force: true });
            await page.waitForTimeout(200);

            // Assert the debug overlay's integrity check saw no drift.
            // (The overlay refreshes every 1 s; wait a beat.)
            await page.waitForTimeout(1_100);
            const integrityText = await page.textContent('#dbg-integrity');
            expect(integrityText,
                `No drift after toggling ${id}`).not.toMatch(/cb=.*mesh=/);

            await cb.setChecked(initial, { force: true });
        }
    });

    test('every feed reaches a non-idle state within 15 s', async ({ page }) => {
        await page.goto(EARTH_URL);
        await waitForSceneReady(page);

        // Poll the debug overlay's feeds block. Any row whose status text
        // still reads 'idle' after 15 s is probably stuck waiting on a
        // network call that will never complete.
        const deadline = Date.now() + 15_000;
        let stuckIdle = [];
        while (Date.now() < deadline) {
            const rows = await page.locator('#dbg-feeds .dbg-row').all();
            stuckIdle = [];
            for (const row of rows) {
                const name  = (await row.locator('.dbg-k').textContent())?.trim();
                const value = (await row.locator('span').nth(1).textContent())?.trim() ?? '';
                if (value.startsWith('idle')) stuckIdle.push(name);
            }
            if (stuckIdle.length === 0) break;
            await page.waitForTimeout(500);
        }
        expect(stuckIdle, `All feeds reached non-idle (stuck: ${stuckIdle.join(', ')})`).toHaveLength(0);
    });

    test('sustains ≥ 25 fps over a 2 s sample', async ({ page }) => {
        await page.goto(EARTH_URL);
        await waitForSceneReady(page);
        await page.waitForTimeout(1_500);    // skip initial-frame jank

        // Sample from the overlay's own median-fps calc (120-frame window).
        await page.waitForTimeout(2_000);
        const fps = Number(await page.textContent('#dbg-fps'));
        expect(fps, 'Sustained ≥ 25 fps').toBeGreaterThanOrEqual(25);
    });

    test('no layer-integrity drift on first paint', async ({ page }) => {
        // Catches the class of regression PR A fixed — NASA overlays
        // visible while their checkboxes are off.  The debug overlay
        // surfaces this as text we can string-match on.
        await page.goto(EARTH_URL);
        await waitForSceneReady(page);
        await page.waitForTimeout(2_500);

        const integrityText = await page.textContent('#dbg-integrity');
        expect(integrityText,
            'Every layer checkbox matches its mesh visibility on first paint'
        ).toContain('layers in sync');
    });
});
