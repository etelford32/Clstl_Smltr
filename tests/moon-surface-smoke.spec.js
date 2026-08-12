import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { LANDMARKS, LANDMARK_CATEGORIES } from '../js/moon-landmarks-data.js';
import { SPECIES } from '../js/moon-exosphere-model.js';

const BUMP_FIXTURE = readFileSync(new URL('./fixtures/moon-bump-test.png', import.meta.url));

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

    // With every texture aborted the height raster never arrived, so the
    // relief layer must report inactive AND no-data — the smooth sphere is
    // the honest state, never invented terrain.
    expect(await page.evaluate(() => window.__moonLab.relief())).toMatchObject({
        active: false,
        dataReady: false,
        exaggeration: 4,
    });
});

test('displaced relief applies from the height raster and re-anchors every layer', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Deterministic relief: serve the checked-in 64×32 fixture as the bump
    // raster (bright disk at lat 0/lon 0, dark disk at lon −90°, gray 96
    // elsewhere); keep the photo texture aborted.
    await page.route('**://upload.wikimedia.org/**', (route) => (
        route.request().url().includes('Moon_bump')
            ? route.fulfill({ status: 200, contentType: 'image/png', body: BUMP_FIXTURE })
            : route.abort()
    ));

    await page.goto('/moon.html');
    await expect(page.locator('#loading')).toHaveClass(/done/, { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => window.__moonLab.relief())).toMatchObject({
        active: true,
        dataReady: true,
        exaggeration: 4,
    });

    // The drawn span matches the fixture through the nominal ±10 km mapping,
    // and never crosses the camera's 1.04 floor.
    const relief = await page.evaluate(() => window.__moonLab.relief());
    expect(relief.maxRadius).toBeGreaterThan(1.015);   // bright disk ≈ gray 250
    expect(relief.minRadius).toBeLessThan(0.99);       // dark disk ≈ gray 10
    expect(relief.maxRadius).toBeLessThan(1.03);
    const probes = await page.evaluate(() => ({
        summit: window.__moonLab.radiusAt(0, 0),
        pit: window.__moonLab.radiusAt(0, -90),
        background: window.__moonLab.radiusAt(45, 90),
    }));
    expect(probes.summit).toBeGreaterThan(1.015);
    expect(probes.pit).toBeLessThan(0.99);
    expect(Math.abs(probes.background - 0.9963)).toBeLessThan(0.004);   // gray 96

    // Every ground-anchored layer re-seats through the SAME radiusAt:
    // a landmark dot sits its clearance above ITS OWN ground…
    const anchor = await page.evaluate(() => {
        const { landmarks, radiusAt } = window.__moonLab;
        const hit = landmarks.hitTargets.find(h => h.userData.landmark.name === 'Copernicus');
        const lm = hit.userData.landmark;
        return { r: hit.position.length(), ground: radiusAt(lm.latDeg, lm.lonDeg) };
    });
    expect(Math.abs(anchor.r - (anchor.ground + 0.008))).toBeLessThan(2e-3);
    // …and the graticule DRAPES: the lon-0 meridian's equator vertex rides
    // the summit disk instead of the smooth 1.001 shell.
    const gridRadius = await page.evaluate(() => {
        const meridian0 = window.__moonLab.gridGroup.children[6];
        const positions = meridian0.geometry.attributes.position;
        return Math.hypot(positions.getX(45), positions.getY(45), positions.getZ(45));
    });
    expect(Math.abs(gridRadius - (probes.summit + 0.001))).toBeLessThan(2e-3);

    // The Terrain Relief toggle round-trips to the exact smooth sphere.
    await page.locator('#lyr-bump').uncheck();
    await expect.poll(() => page.evaluate(() => window.__moonLab.relief().active)).toBe(false);
    const smoothGrid = await page.evaluate(() => {
        const meridian0 = window.__moonLab.gridGroup.children[6];
        const positions = meridian0.geometry.attributes.position;
        return Math.hypot(positions.getX(45), positions.getY(45), positions.getZ(45));
    });
    expect(Math.abs(smoothGrid - 1.001)).toBeLessThan(1e-6);
    await page.locator('#lyr-bump').check();
    await expect.poll(() => page.evaluate(() => window.__moonLab.relief().active)).toBe(true);

    // ── Descent mode over the fixture summit ──
    // The Mars surface-explorer architecture, ported: local-horizon camera
    // (with the OrbitControls orbit-axis REBUILD), clearance guard against
    // radiusAt, instruments, reticle, WASD traverse, Esc back to orbit.
    await page.evaluate(() => window.__moonLab.enterDescent(0, 0, 'Fixture summit'));
    await expect.poll(() => page.evaluate(() => {
        const d = window.__moonLab.descent();
        return d.active && !d.tweening;
    }), { timeout: 10_000 }).toBe(true);
    await expect(page.locator('#descent-hud')).toBeVisible();
    await expect(page.locator('#dh-site')).toHaveText('Fixture summit');
    const descent = await page.evaluate(() => window.__moonLab.descent());
    expect(descent.aglKm).toBeGreaterThan(1.1);      // never inside the clearance floor
    expect(descent.aglKm).toBeLessThan(60);
    expect(descent.hdgDeg).toBeGreaterThanOrEqual(0);
    expect(descent.hdgDeg).toBeLessThan(360);
    expect(descent.slopeDeg).toBeGreaterThanOrEqual(0);
    expect(Math.abs(descent.sunElevDeg)).toBeLessThanOrEqual(90);
    expect(descent.reliefApplied).toBe(true);
    await expect(page.locator('#dh-relief')).toContainText('×4');
    // The orbit-axis rebuild actually happened: camera.up is the target's
    // local radial, not world +Y (target sits on the equator, so the two
    // frames are ~90° apart — this catches a missing rebuildControls cold).
    const frame = await page.evaluate(() => {
        const { camera, controls } = window.__moonLab;
        return {
            upDotRadial: camera.up.clone().normalize()
                .dot(controls.target.clone().normalize()),
            minDistance: controls.minDistance,
        };
    });
    expect(frame.upDotRadial).toBeGreaterThan(0.99);
    expect(frame.minDistance).toBeLessThan(0.01);
    // WASD traverse: a forward step moves the target north from the entry
    // heading and the instruments keep reporting.
    const latBefore = descent.latDeg;
    await page.evaluate(() => window.__moonLab.nudgeDescent(1, 0));
    const afterStep = await page.evaluate(() => window.__moonLab.descent());
    expect(afterStep.latDeg).toBeGreaterThan(latBefore + 0.1);
    expect(afterStep.aglKm).toBeGreaterThan(1.1);
    // Esc returns to orbit and restores the world frame + orbit limits.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__moonLab.descent().active)).toBe(false);
    await expect(page.locator('#descent-hud')).toBeHidden();
    const restored = await page.evaluate(() => ({
        up: window.__moonLab.camera.up.toArray(),
        minDistance: window.__moonLab.controls.minDistance,
        near: window.__moonLab.camera.near,
        radius: window.__moonLab.camera.position.length(),
    }));
    expect(restored.up[1]).toBeCloseTo(1, 6);
    expect(restored.minDistance).toBeCloseTo(1.04, 6);
    expect(restored.near).toBeCloseTo(0.001, 6);
    expect(restored.radius).toBeGreaterThan(1.04);

    expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toHaveLength(0);
});
