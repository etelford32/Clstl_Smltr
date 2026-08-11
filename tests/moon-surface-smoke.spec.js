import { test, expect } from '@playwright/test';
import { LANDMARKS, LANDMARK_CATEGORIES } from '../js/moon-landmarks-data.js';
import { SPECIES } from '../js/moon-exosphere-model.js';

/**
 * moon-surface-smoke.spec.js — the Moon page's exosphere + landmarks +
 * living-dynamo layers (companion to moon-interior-smoke.spec.js).
 *
 * Wikimedia texture routes are ABORTED so the run is deterministic and
 * offline-safe. Checks:
 *   1. Page boots with no pageerrors and no THREE shader errors — this is
 *      what catches a GLSL typo in the exosphere glow/tail shaders or the
 *      u_dynamo addition to the outer-core shader.
 *   2. The exosphere panel renders one species row per kernel species and
 *      live sodium-weather "×" readouts; the HUD carries the Na line.
 *   3. The landmarks panel renders one toggle per category and one row per
 *      landmark (counts imported from the SAME data module the page uses,
 *      so panel and data cannot drift); category toggles and row clicks
 *      don't error.
 *   4. The dynamo scrubber surfaces the kernel's mechanism story: the
 *      precession candidate at 4 Ga, crustal remanence today.
 */

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost'],
    },
    ignoreHTTPSErrors: true,
});

test('moon exosphere, landmarks, and dynamo mechanisms boot and respond', async ({ page }) => {
    const pageErrors = [];
    const shaderErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
        const t = msg.text();
        if (t.includes('THREE.WebGLProgram') || t.includes('THREE.WebGLShader')) shaderErrors.push(t);
    });

    // Deterministic offline run: no live texture fetches
    await page.route('**://upload.wikimedia.org/**', (route) => route.abort());

    await page.goto('/moon.html');
    await expect(page.locator('#loading')).toHaveClass(/done/, { timeout: 30_000 });

    // Let a few frames render so every material actually compiles
    await page.waitForTimeout(1500);
    expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toHaveLength(0);
    expect(shaderErrors, `shader errors: ${shaderErrors.join('\n')}`).toHaveLength(0);

    // ── Exosphere panel: species table from the kernel ──
    await expect(page.locator('#ip-exo-species .exo-row')).toHaveCount(SPECIES.length);
    await expect(page.locator('#ip-exo-species')).toContainText('Sodium');
    await expect(page.locator('#ip-exo-species')).toContainText('Argon-40');
    // Live sodium weather populated with ×-readouts
    await expect(page.locator('#ip-exo-total')).toContainText('×');
    await expect(page.locator('#ip-exo-psd')).toContainText('×');
    await expect(page.locator('#ip-exo-shower')).not.toHaveText('—');
    // HUD sodium line
    await expect(page.locator('#h-exo')).toContainText('Na ×');

    // ── Landmarks panel: counts pinned to the data module ──
    const nCategories = Object.keys(LANDMARK_CATEGORIES).length;
    await expect(page.locator('#ip-landmark-toggles input[data-lm-cat]')).toHaveCount(nCategories);
    await expect(page.locator('#ip-landmarks .lm-row')).toHaveCount(LANDMARKS.length);
    await expect(page.locator('#ip-landmarks')).toContainText('Tycho');
    await expect(page.locator('#ip-landmarks')).toContainText('South Pole–Aitken');

    // ── Regional terrain synth: boots on Reiner Gamma, discloses its seed ──
    // Textures are aborted in this spec, so the synth MUST report the
    // landmark-catalog fallback — a run that claims measured albedo while the
    // base map never arrived is lying about provenance.
    await expect(page.locator('#synth-site')).toContainText('Reiner Gamma');
    await expect(page.locator('#synth-prov')).toContainText('fallback');
    await expect(page.locator('#synth-prov')).toContainText('synthesized');
    await expect(page.locator('#synth-legend')).toContainText('Mare basalt');
    const synthState = await page.evaluate(() => window.__moonLab.terrainSynth());
    expect(synthState.site).toBe('Reiner Gamma');
    expect(synthState.shares.maria).toBeGreaterThan(0.3);
    expect(synthState.shares.swirl).toBeGreaterThan(0);
    // The canvas actually painted (not a blank rectangle).
    const synthPainted = await page.evaluate(() => {
        const canvas = document.querySelector('#synth-canvas');
        const data = canvas.getContext('2d').getImageData(0, 0, 40, 40).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += data[i];
        return sum;
    });
    expect(synthPainted).toBeGreaterThan(1000);

    // ── Graticule accuracy: the two past bugs stay fixed ──
    // (1) mounted on the rotating moon mesh, not the scene; (2) built with
    // latLonToXYZ, so the lon-0 meridian's equator vertex sits at +X — the
    // old mirrored inline trig put it at +Z, which this catches.
    const grid = await page.evaluate(() => {
        const { gridGroup, moonMesh } = window.__moonLab;
        const meridian0 = gridGroup.children[6];      // lon = −180 + 6·30 = 0°
        const positions = meridian0.geometry.attributes.position;
        const equatorIndex = 45;                       // lat = −90 + 45·2 = 0°
        return {
            parentIsMoonMesh: gridGroup.parent === moonMesh,
            equatorVertex: [
                positions.getX(equatorIndex),
                positions.getY(equatorIndex),
                positions.getZ(equatorIndex),
            ],
        };
    });
    expect(grid.parentIsMoonMesh).toBe(true);
    expect(grid.equatorVertex[0]).toBeCloseTo(1.001, 3);
    expect(Math.abs(grid.equatorVertex[1])).toBeLessThan(1e-6);
    expect(Math.abs(grid.equatorVertex[2])).toBeLessThan(1e-6);

    // Hover tooltip: project a camera-facing marker via the __moonLab hook
    // and move the mouse onto it — deterministic, no blind sweeps.
    const pt = await page.evaluate(() => {
        const { camera, renderer, landmarks } = window.__moonLab;
        const rect = renderer.domElement.getBoundingClientRect();
        const camN = camera.position.clone().normalize();
        for (const h of landmarks.hitTargets) {
            const lm = h.userData.landmark;
            if (!landmarks.isLandmarkVisible(lm)) continue;
            const wp = h.getWorldPosition(new h.position.constructor());
            if (wp.clone().normalize().dot(camN) < 0.55) continue;   // near hemisphere only
            const p = wp.project(camera);
            return {
                x: rect.left + (p.x * 0.5 + 0.5) * rect.width,
                y: rect.top + (-p.y * 0.5 + 0.5) * rect.height,
                name: lm.name,
            };
        }
        return null;
    });
    expect(pt, 'a camera-facing landmark hit target exists').not.toBeNull();
    await page.mouse.move(pt.x, pt.y);
    await expect(page.locator('#lm-tip')).toBeVisible();
    await expect(page.locator('#lm-tip .lt-name')).not.toBeEmpty();
    // Moving off the disk hides it
    await page.mouse.move(30, 400);
    await expect(page.locator('#lm-tip')).toBeHidden();

    // Category toggle + row click (pulse) survive without errors — and the
    // row click now ALSO re-synthesizes the terrain card for that site.
    await page.locator('input[data-lm-cat="mare"]').uncheck();
    await page.locator('.lm-row', { hasText: 'Tycho' }).first().click();
    await page.waitForTimeout(300);
    await expect(page.locator('#synth-site')).toContainText('Tycho');
    const tychoSynth = await page.evaluate(() => window.__moonLab.terrainSynth());
    expect(tychoSynth.site).toBe('Tycho');
    expect(tychoSynth.shares.highlands).toBeGreaterThan(0.3);

    // Exosphere layer toggles
    await page.locator('#lyr-exo').uncheck();
    await page.locator('#lyr-natail').uncheck();
    await page.waitForTimeout(200);
    await page.locator('#lyr-exo').check();

    // ── Interior: the dynamo mechanism story rides the scrubber ──
    await page.click('#vt-interior');
    await expect(page.locator('#info-panel')).toHaveClass(/interior-mode/);
    await page.locator('#dyn-age').fill('-4');
    await expect(page.locator('#ip-dyn-mech')).toContainText(/precession/i);
    await page.locator('#dyn-age').fill('0');
    await expect(page.locator('#ip-dyn-mech')).toContainText(/magnetized crust/i);

    // Back to surface: exosphere returns with the view
    await page.click('#vt-surface');
    await page.waitForTimeout(300);

    // Still no errors after the whole dance
    expect(pageErrors, `late page errors: ${pageErrors.join('\n')}`).toHaveLength(0);
    expect(shaderErrors, `late shader errors: ${shaderErrors.join('\n')}`).toHaveLength(0);
});
