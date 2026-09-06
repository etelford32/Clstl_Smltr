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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { solarEphemeris } from '../js/sun-observed.js';

const PAGE = '/sun.html';
const BOOT_TIMEOUT_MS = 20_000;

// ── Observed-disk fixtures (SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 1) ─────────
// The synthetic SDO frames under tests/fixtures/sdo stand in for
// /api/solar/aia so CI never needs nasa.gov. See that folder's README.
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sdo');
const FIXTURE_MANIFEST = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));

/** Serve the synthetic frame for the requested channel, with the provenance header the page reads. */
// Stamp frames 7 min old by default so the chip reads live (the manifest's
// noon epoch would honestly read 'expired' by the afternoon — and did).
async function routeAiaToFixtures(page, { observedAt = new Date(Date.now() - 7 * 60 * 1000).toISOString() } = {}) {
    const hits = [];
    await page.route('**/api/solar/aia*', (route) => {
        const u = new URL(route.request().url());
        const ch = u.searchParams.get('channel') || 'white';
        hits.push(ch);
        const frame = FIXTURE_MANIFEST.frames[ch] || FIXTURE_MANIFEST.frames.white;
        route.fulfill({
            status: 200,
            headers: {
                'Content-Type': 'image/png',
                'X-AIA-Channel': ch,
                'X-AIA-Mode': 'live',
                'X-SDO-Observed-At': observedAt,
                'Access-Control-Expose-Headers': 'X-AIA-Channel, X-AIA-Mode, X-SDO-Observed-At',
            },
            body: readFileSync(join(FIXTURE_DIR, frame.file)),
        });
    });
    return hits;
}

/** Make the proxy fail like a sandbox without egress (502 JSON, the route's real failure shape). */
async function routeAiaDown(page) {
    await page.route('**/api/solar/aia*', (route) => route.fulfill({
        status: 502, contentType: 'application/json',
        body: JSON.stringify({ error: 'aia_unavailable', detail: 'test: feed down' }),
    }));
}

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
// `telemetry` + 501: /api/telemetry/log answers 501 not_configured wherever
// SUPABASE_SERVICE_KEY is absent (any sandbox running dev-server.mjs) — the
// same expected-degradation class as the supabase entry above. 502: the
// same-origin /api/noaa/passthrough mirror gateways NOAA and answers 502
// when the sandbox has no outbound network; the console text carries only
// the status, never the URL, so the status code is the only handle.
function isExpectedNoise(text) {
    return /supabase|jsdelivr|unpkg|cdn|Failed to fetch|net::ERR|ERR_|CORS|swpc|noaa|donki|\bhek\b|nasa|soho|sdo|gibs|celestrak|telemetry|429|404|501|502|503|net::/i
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
        await page.goto(PAGE);
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
        await page.goto(PAGE);
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
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        const f0 = await page.evaluate(() => window.__sun.frames);
        await page.waitForTimeout(1000);
        const f1 = await page.evaluate(() => window.__sun.frames);
        expect(f1, 'frame counter advances over ~1s').toBeGreaterThan(f0 + 5);
    });

    test('cutaway peel toggles + depth slider without throwing', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(PAGE);
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
        await page.goto(PAGE);
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
        await page.goto(PAGE);
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

    // ── Observed disk (Phase 1) ──────────────────────────────────────────────
    test('feed down → boots in MODEL mode, chip says so, u_obsOn stays 0', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await routeAiaDown(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.observed && window.__sun.observed.reason === 'feed-down', { timeout: BOOT_TIMEOUT_MS });
        const st = await page.evaluate(() => ({
            obsOn: window.__sun.uniforms.u_obsOn.value,
            mode:  window.__sun.observed.mode,
            chip:  document.getElementById('sun-provenance').textContent,
            cls:   document.getElementById('sun-provenance').className,
        }));
        expect(st.obsOn, 'u_obsOn is 0 with no frame').toBe(0);
        expect(st.mode).toBe('model');
        expect(st.chip).toMatch(/^MODEL · procedural photosphere · feed down$/);
        expect(st.cls).toContain('prov-model');
        // The procedural photosphere still renders (this IS the CI path).
        await page.waitForFunction(() => window.__sun.frames > 5, { timeout: BOOT_TIMEOUT_MS });
        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors on the feed-down path').toHaveLength(0);
    });

    test('observed by default: fixture frame wraps the disk, chip says OBSERVED with instrument + age, rotation goes real-time', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        const hits = await routeAiaToFixtures(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.observed?.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.frames > 5, { timeout: BOOT_TIMEOUT_MS });
        const st = await page.evaluate(() => {
            const u = window.__sun.uniforms;
            return {
                obsOn: u.u_obsOn.value, hasTex: !!u.u_obsTex.value, kind: u.u_obsKind.value,
                geom: u.u_obsGeom.value.toArray(), b0: u.u_obsB0.value,
                rot: u.u_rot.value, hudRot: document.getElementById('hud-rot').textContent,
                state: window.__sun.observed,
                chip: document.getElementById('sun-provenance').textContent,
                cls: document.getElementById('sun-provenance').className,
            };
        });
        expect(hits[0], 'first fetch is the white-light frame').toBe('white');
        expect(st.obsOn).toBe(1);
        expect(st.hasTex).toBe(true);
        expect(st.kind).toBe(0);
        expect(st.state.channel).toBe('white');
        expect(st.state.pAngleApplied, 'P is exposed, not applied').toBe(false);
        expect(st.chip).toMatch(/^OBSERVED · SDO\/HMI continuum · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · 7 min old$/);
        expect(st.cls).toContain('prov-observed');
        // Disk geometry is MEASURED from the frame (synthetic HMI: r = 0.465 of the frame).
        expect(st.state.geometry).toBe('measured');
        expect(Math.abs(st.geom[2] - 0.465)).toBeLessThan(0.465 * 0.012);
        // B0 is the ephemeris value for the frame's observation time (today − 7 min).
        expect(Math.abs(st.b0 * 180 / Math.PI - solarEphemeris(new Date()).b0Deg)).toBeLessThan(0.05);
        // Observed ⇒ real-time rotation multiplier, and the HUD says so.
        expect(st.rot).toBeLessThan(0.01);
        expect(st.hudRot).toContain('real-time');
        // Phase 2 post chain is live: a 6-mip bloom chain at 720p and a finite
        // luminance readback (the exposure controller is being fed).
        const post = await page.evaluate(() => window.__sun.post.state);
        expect(post.mips).toBe(6);
        expect(Number.isFinite(post.avgLogLum), 'luminance readback works').toBe(true);
        expect(post.bloomEnabled && post.flareEnabled).toBe(true);
        expect(post.lens, 'lens effects are OFF by default in Observed mode').toBe(false);
        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors on the observed path').toHaveLength(0);
    });

    test('EUV mode fetches the matching AIA frame; cutaway / Doppler drop to MODEL and restore; chip click toggles', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        const hits = await routeAiaToFixtures(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.observed?.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });
        const setView = (v) => page.evaluate((val) => {
            const el = document.getElementById('view-mode');
            el.value = val; el.dispatchEvent(new Event('change', { bubbles: true }));
        }, v);
        const setTog = (id, on) => page.evaluate(({ id, on }) => {
            const el = document.getElementById(id);
            if (el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); }
        }, { id, on });
        const obs = () => page.evaluate(() => ({
            on: window.__sun.uniforms.u_obsOn.value, kind: window.__sun.uniforms.u_obsKind.value,
            geomR: window.__sun.uniforms.u_obsGeom.value.z,
            st: window.__sun.observed, chip: document.getElementById('sun-provenance').textContent,
        }));

        // 171 Å → the AIA frame (kind 1, AIA disk fraction ≈ 0.390 measured).
        await setView('2');
        await page.waitForFunction(() => window.__sun.observed?.mode === 'observed' && window.__sun.observed.channel === '171', { timeout: BOOT_TIMEOUT_MS });
        let s = await obs();
        expect(hits).toContain('171');
        expect(s.kind).toBe(1);
        expect(Math.abs(s.geomR - 0.390)).toBeLessThan(0.390 * 0.012);
        expect(s.chip).toMatch(/^OBSERVED · SDO\/AIA 171 Å/);

        // Magnetogram → HMI LOS (kind 2).
        await setView('6');
        await page.waitForFunction(() => window.__sun.observed?.channel === 'mag' && window.__sun.observed.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });
        s = await obs();
        expect(s.kind).toBe(2);
        await setView('0');
        await page.waitForFunction(() => window.__sun.observed?.channel === 'white' && window.__sun.observed.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });

        // Cutaway is a MODEL view: observed off while peeled, back when un-peeled.
        await setTog('tog-cutaway', true);
        await page.waitForTimeout(150);
        s = await obs();
        expect(s.on).toBe(0);
        expect(s.chip).toMatch(/^MODEL · procedural photosphere · cutaway$/);
        await setTog('tog-cutaway', false);
        await page.waitForFunction(() => window.__sun.observed?.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });
        s = await obs();
        expect(s.on).toBe(1);

        // Doppler likewise.
        await setTog('tog-doppler', true);
        await page.waitForTimeout(150);
        s = await obs();
        expect(s.on).toBe(0);
        expect(s.chip).toMatch(/^MODEL · procedural photosphere · Doppler$/);
        await setTog('tog-doppler', false);
        await page.waitForFunction(() => window.__sun.observed?.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });

        // The chip is the toggle: click → Model (sim rotation restored), click → Observed.
        await page.evaluate(() => document.getElementById('sun-provenance').click());
        await page.waitForTimeout(100);
        s = await obs();
        expect(s.on).toBe(0);
        expect(s.chip).toMatch(/^MODEL · procedural photosphere$/);
        const rotModel = await page.evaluate(() => window.__sun.uniforms.u_rot.value);
        expect(rotModel).toBeGreaterThanOrEqual(0.2);
        await page.evaluate(() => document.getElementById('sun-provenance').click());
        await page.waitForFunction(() => window.__sun.observed?.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });
        s = await obs();
        expect(s.on).toBe(1);

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors switching observed/model').toHaveLength(0);
    });

    test('?observed=0 boots in MODEL mode by user choice (rotation stays the sim rate)', async ({ page }) => {
        await routeAiaToFixtures(page);
        await page.goto(PAGE + '?observed=0');
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(300);
        const st = await page.evaluate(() => ({
            on: window.__sun.uniforms.u_obsOn.value, rot: window.__sun.uniforms.u_rot.value,
            chip: document.getElementById('sun-provenance').textContent,
        }));
        expect(st.on).toBe(0);
        expect(st.rot).toBe(1);
        expect(st.chip).toMatch(/^MODEL · procedural photosphere$/);
    });
});
