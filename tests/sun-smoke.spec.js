/**
 * sun-smoke.spec.js — boot + 7-layer + animation smoke test
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies sun.html loads without console / shader-compile errors, all seven
 * structural layers (core, radiative, convective, photosphere, chromosphere,
 * transition region, corona) toggle without throwing, and the render loop keeps
 * advancing. Mirrors the style of upper-atmosphere-smoke.spec.js, leaning on
 * the exposed `window.__sun` handle.
 *
 * This is the Phase-0 regression guard for the convection visual upgrade
 * (see SUN_CONVECTION_UPGRADE_PLAN.md): a shader-compile failure in the
 * photosphere / interior shaders surfaces here as a console error.
 */

import { test, expect } from '@playwright/test';

const URL = '/sun.html';
const BOOT_TIMEOUT_MS = 20_000;

function attachConsoleRecorder(page) {
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push({ text: msg.text(), location: msg.location() });
    });
    page.on('pageerror', (err) => errors.push({ text: err.message, stack: err.stack }));
    return errors;
}

// Live space-weather feeds (NOAA SWPC, NASA DONKI/HEK, SDO/SOHO imagery) and the
// Supabase / CDN clients routinely fail in a sandbox; the page is built to
// degrade to its procedural model. Those are expected, not page faults. Shader
// compile errors ("THREE.WebGLProgram: Shader Error", program info logs) do NOT
// match this filter, so they still fail the test.
function isExpectedNoise(text) {
    return /supabase|jsdelivr|unpkg|cdn|Failed to fetch|net::ERR|ERR_|CORS|swpc|noaa|donki|\bhek\b|nasa|soho|sdo|gibs|celestrak|429|404|503|net::/i
        .test(text || '');
}

const LAYER_TOGGLES = [
    'tog-core', 'tog-radiative', 'tog-convective',
    'tog-photosphere', 'tog-chrom', 'tog-tr', 'tog-corona',
];

test.describe('sun.html smoke', () => {

    // Pre-seed cookie consent so the banner never mounts and intercepts clicks.
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch (e) {}
        });
    });

    test('boots and renders frames without shader/console errors', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(URL);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        // Let the WebGL scene + post-processing render several frames; a broken
        // shader would have logged a compile error by now.
        await page.waitForFunction(() => window.__sun.frames > 5, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(800);

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no unexpected console / shader-compile errors').toHaveLength(0);
    });

    test('all 7 structural layers toggle without throwing', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(URL);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(500);

        // Flip every layer toggle and flip it back, exercising the visibility
        // wiring + any isolation-uniform side effects in both directions.
        // The real checkboxes are visually hidden behind styled rows, so drive
        // them programmatically and fire the 'change' event the page listens for
        // (exercises the real visibility handlers without click flake).
        const setLayer = (id, on) => page.evaluate(({ id, on }) => {
            const el = document.getElementById(id);
            if (el.checked !== on) {
                el.checked = on;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, { id, on });

        // Flip every layer to the opposite of its default, then back.
        for (const id of LAYER_TOGGLES) {
            const before = await page.evaluate((i) => document.getElementById(i).checked, id);
            await setLayer(id, !before);
            await page.waitForTimeout(60);
            await setLayer(id, before);
            await page.waitForTimeout(60);
        }

        // Drive a concrete cutaway-style state: interior on, photosphere off.
        await setLayer('tog-core', true);
        await setLayer('tog-convective', true);
        await setLayer('tog-photosphere', false);
        await page.waitForTimeout(150);
        const vis = await page.evaluate(() => ({
            core:        window.__sun.layers.core.visible,
            convective:  window.__sun.layers.convective.visible,
            photosphere: window.__sun.layers.photosphere.visible,
        }));
        expect(vis.core, 'core visible after check').toBe(true);
        expect(vis.convective, 'convective visible after check').toBe(true);
        expect(vis.photosphere, 'photosphere hidden after uncheck').toBe(false);

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors while toggling layers').toHaveLength(0);
    });

    test('animation loop keeps advancing', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        const f0 = await page.evaluate(() => window.__sun.frames);
        await page.waitForTimeout(1000);
        const f1 = await page.evaluate(() => window.__sun.frames);
        expect(f1, 'frame counter advances over ~1s').toBeGreaterThan(f0 + 5);
    });

    test('cutaway peel toggles + depth slider without throwing', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(URL);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(500);

        // Enable cutaway (checkbox is visually hidden — fire the change event).
        await page.evaluate(() => {
            const el = document.getElementById('tog-cutaway');
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(250);

        // Interior convective shell is revealed; the photosphere mesh stays in
        // the scene (it is clipped per-fragment, not hidden).
        const on = await page.evaluate(() => ({
            convective:  window.__sun.layers.convective.visible,
            photosphere: window.__sun.layers.photosphere.visible,
        }));
        expect(on.convective, 'convective revealed in cutaway').toBe(true);
        expect(on.photosphere, 'photosphere mesh stays (clipped, not hidden)').toBe(true);

        // Sweep the cut-depth slider (drives u_cutOffset).
        await page.evaluate(() => {
            const s = document.getElementById('sl-cutdepth');
            for (const v of ['10', '85', '45']) {
                s.value = v;
                s.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        await page.waitForTimeout(150);

        // Disable cutaway again; the convective shell returns to its prior state.
        await page.evaluate(() => {
            const el = document.getElementById('tog-cutaway');
            el.checked = false;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(150);

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors toggling cutaway + slider').toHaveLength(0);
    });

    test('Doppler velocity view toggles cleanly', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(URL);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(500);

        await page.evaluate(() => {
            const el = document.getElementById('tog-doppler');
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(250);
        const on = await page.evaluate(() => ({
            photosphere: window.__sun.layers.photosphere.visible,
            corona: window.__sun.layers.corona.visible,
            legend: document.getElementById('doppler-legend')?.style.display,
        }));
        expect(on.photosphere, 'photosphere shown in Doppler mode').toBe(true);
        expect(on.corona, 'corona hidden in Doppler mode').toBe(false);
        expect(on.legend, 'legend visible in Doppler mode').toBe('block');

        await page.evaluate(() => {
            const el = document.getElementById('tog-doppler');
            el.checked = false;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(200);
        const legendOff = await page.evaluate(() => document.getElementById('doppler-legend')?.style.display);
        expect(legendOff, 'legend hidden after exit').toBe('none');

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors toggling Doppler').toHaveLength(0);
    });

    test('EUV / magnetogram wavelength views cycle cleanly', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(URL);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(500);

        // Cycle every channel (304/171/193/211/131/magnetogram) then back to white light.
        for (const v of ['1', '2', '3', '4', '5', '6', '0']) {
            await page.evaluate((val) => {
                const el = document.getElementById('view-mode');
                el.value = val;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, v);
            await page.waitForTimeout(150);
            const mode = await page.evaluate(() => window.__sun.uniforms.u_viewMode.value);
            expect(mode, `u_viewMode set to ${v}`).toBe(parseFloat(v));
        }

        // A channel view hides the white-light corona shell.
        await page.evaluate(() => {
            const el = document.getElementById('view-mode');
            el.value = '1';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(150);
        const coronaInChannel = await page.evaluate(() => window.__sun.layers.corona.visible);
        expect(coronaInChannel, 'corona hidden in channel view').toBe(false);

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors cycling wavelength views').toHaveLength(0);
    });
});
