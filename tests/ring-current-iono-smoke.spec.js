import { test, expect } from '@playwright/test';

/**
 * ring-current-iono-smoke.spec.js — M-I coupling layer (Tracks 0 + A of
 * IONOSPHERE_EXPLORATION_PLAN.md) on the live ring-current page.
 *
 * Checks:
 *   1. The page boots with the ionosphere layer: airglow/streamline shaders
 *      COMPILE (a GLSL error surfaces as a THREE.WebGLProgram console
 *      error), the fountain kernel carries its 72 cells, and the efield
 *      state is finite and shielded (ΔA ≈ 0) at quiet boot.
 *   2. The plasmapause teardrop has its dusk bulge: boundary radius at dusk
 *      exceeds dawn (the last-closed-equipotential geometry, not a circle).
 *   3. Driving the shielding ODE (a southward-turning driver injected via
 *      the probe handle) produces ΔA > 0 within sim-seconds and the HUD
 *      penetration bar goes east/orange — kernels → globe → DOM, one loop.
 *   4. The legend row toggles the layer off and on.
 *   5. No uncaught page errors through the whole dance.
 *
 * The live NOAA feeds may fail in CI — irrelevant here: the globe boots on
 * quiet defaults and the probe drives the physics directly.
 */

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost'],
    },
    ignoreHTTPSErrors: true,
});

test('ionosphere layer boots, teardrop bulges duskward, penetration reaches the HUD', async ({ page }) => {
    const pageErrors = [];
    const shaderErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
        const t = msg.text();
        if (/THREE\.WebGLProgram|Shader Error|VALIDATE_STATUS/i.test(t)) shaderErrors.push(t);
    });

    await page.goto('/ring-current.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.rcGlobe, null, { timeout: 30_000 });
    // A few frames so every program actually compiles/links and the layer ticks.
    await page.waitForTimeout(3000);

    // 1. Kernels present, efield finite and shielded at boot.
    const boot = await page.evaluate(() => {
        const g = window.rcGlobe;
        const s = g.efieldState();
        return {
            cells: g.ionosphere.cells.length,
            aDrv: s.A_drv, aSh: s.A_sh, dA: s.dA, ls: s.stagnationL,
            layerVisible: g._ionoLayer.group.visible,
            shellDrawn: g._ionoLayer.group.children.length,
        };
    });
    expect(boot.cells).toBe(72);
    expect(Number.isFinite(boot.aDrv)).toBe(true);
    expect(boot.aSh).toBeGreaterThan(0);
    expect(Math.abs(boot.dA)).toBeLessThan(0.3);         // near-shielded quiet boot
    expect(boot.ls).toBeGreaterThan(2);
    expect(boot.layerVisible).toBe(true);
    expect(boot.shellDrawn).toBeGreaterThan(1);          // shell + 12 streamlines

    // 2. Teardrop dusk bulge, read straight off the built polyline.
    const tear = await page.evaluate(() => {
        const pos = window.rcGlobe._ppTear.geometry.getAttribute('position');
        const n = pos.count;
        const L = (i) => Math.hypot(pos.getX(i), pos.getZ(i));
        return { dusk: L(Math.round(n / 4)), dawn: L(Math.round(3 * n / 4)) };
    });
    expect(tear.dusk).toBeGreaterThan(tear.dawn * 1.2);

    // 3. Southward turning via the probe: driver jumps, shield lags. ΔA
    //    rises SYNCHRONOUSLY with setDriver (state() is A_drv − A_sh), so
    //    assert it in the same evaluate — a live feed event overwriting the
    //    injected driver later can't race this. The HUD bar repaints on a
    //    250 ms interval; give it a short window.
    const dAafter = await page.evaluate(() => {
        // Two calls: the first is a no-op if the live feed already primed
        // the shield, and IS the primer when feeds are unreachable in CI —
        // either way the second call is a genuine southward transient.
        window.rcGlobe._efield.setDriver({ kp: 1, vbs: 0 });
        window.rcGlobe._efield.setDriver({ kp: 7, vbs: 6 });
        return window.rcGlobe.efieldState().dA;
    });
    expect(dAafter).toBeGreaterThan(0.3);
    await page.waitForFunction(() => {
        const el = document.getElementById('rc-ef-pen');
        return el && el.classList.contains('rc-ef-pen-east') && parseFloat(el.style.width) > 0;
    }, null, { timeout: 3_000 });
    const vals = await page.locator('#rc-ef-vals').textContent();
    expect(vals).toMatch(/kV\/Rᴇ²/);

    // 4. Legend toggle round-trip.
    const row = page.locator('.rc-legend-pop[data-pop="iono"]');
    await row.click();
    expect(await page.evaluate(() => window.rcGlobe._ionoLayer.group.visible)).toBe(false);
    await row.click();
    expect(await page.evaluate(() => window.rcGlobe._ionoLayer.group.visible)).toBe(true);

    // 5. M2: the WFC cell engine runs on the sim clock and its bake is the
    //    global shell texture; the hover inspector's conversion math
    //    (world point → maglat/MLT → cell → state + why) is pinned via
    //    cellInfoAt with a point minted over the north polar/auroral zone.
    const wfc = await page.evaluate(() => {
        const g = window.rcGlobe;
        let painted = 0;
        const d = g._ionoLayer._mapData;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 40) painted++;
        // Local shell point at geographic 62.5°N, 72.68°W (the dipole-pole
        // meridian → maglat ≈ 72°), pushed through the live world matrix.
        const lat = 62.5 * Math.PI / 180, lon = -72.68 * Math.PI / 180, r = 1.03;
        const local = g._tmpV.set(
            r * Math.cos(lat) * Math.cos(lon),
            r * Math.sin(lat),
            -r * Math.cos(lat) * Math.sin(lon)).clone();
        const world = g._ionoLayer.mapShell.localToWorld(local);
        const info = g.cellInfoAt(world);
        return {
            epochs: g.cells.stats.epochs,
            contradictions: g.cells.stats.contradictions,
            mapVisible: g._ionoLayer.mapShell.visible,
            painted, info,
        };
    });
    expect(wfc.epochs).toBeGreaterThan(0);
    expect(wfc.contradictions).toBe(0);
    expect(wfc.mapVisible).toBe(true);
    expect(wfc.painted).toBeGreaterThan(200);
    expect(wfc.info).not.toBeNull();
    expect(['quiet', 'crest', 'bubble', 'arc', 'diffuse', 'trough']).toContain(wfc.info.state);
    expect(Math.abs(wfc.info.maglat)).toBeGreaterThan(65);
    expect(wfc.info.why.length).toBeGreaterThan(0);

    // Map toggle is independent of the airglow toggle.
    const mapRow = page.locator('.rc-legend-pop[data-pop="cells"]');
    await mapRow.click();
    expect(await page.evaluate(() => window.rcGlobe._ionoLayer.mapShell.visible)).toBe(false);
    await mapRow.click();
    expect(await page.evaluate(() => window.rcGlobe._ionoLayer.mapShell.visible)).toBe(true);

    // 6. M3 — the descent camera. Surface view (instant, aimed at the
    //    auroral zone so the LOD pool has arc cells to instantiate) engages
    //    the disclosed exaggeration: shells inflate via uExag, the D/E/F
    //    stack fades in, detail curtains assign, and descentState reports
    //    the TRUE altitude the HUD discloses.
    const m3 = await page.evaluate(() => {
        const g = window.rcGlobe;
        const dir = g._tmpV.set(0.30, 0.92, 0.25).clone().normalize();
        const okView = g.setView('surface', { instant: true, anchorWorldDir: dir });
        return { okView, camDist: g._camera.position.length(), view: g.view };
    });
    expect(m3.okView).toBe(true);
    expect(m3.view).toBe('surface');
    expect(m3.camDist).toBeCloseTo(1.42, 1);
    // Let a few ticks + one 4 Hz detail sync + the 250 ms HUD interval run.
    await page.waitForTimeout(1200);
    const engaged = await page.evaluate(() => {
        const g = window.rcGlobe;
        const ds = g.descentState();
        return {
            ds,
            uExagShell: g._ionoLayer._shellMat.uniforms.uExag.value,
            uExagCage: g._cageMat.uniforms.uExag.value,
            layerShellsOn: g._ionoLayer._layerShells.filter(L => L.mesh.visible).length,
            perfCells: g.perf.cells,
            hud: document.getElementById('rc-descent'),
            hudText: document.getElementById('rc-descent')?.textContent ?? '',
            hudHidden: document.getElementById('rc-descent')?.hidden,
        };
    });
    expect(engaged.ds.engaged).toBe(true);
    expect(engaged.ds.exag).toBe(18);
    expect(engaged.uExagShell).toBe(18);
    expect(engaged.uExagCage).toBe(18);
    expect(engaged.ds.altKmReal).toBeGreaterThan(120);
    expect(engaged.ds.altKmReal).toBeLessThan(180);
    expect(engaged.layerShellsOn).toBe(3);           // D/E/F stack visible
    expect(engaged.ds.details).toBeGreaterThan(0);   // curtains over the oval
    expect(engaged.perfCells).toBe(engaged.ds.details);
    expect(engaged.hudHidden).toBe(false);
    expect(engaged.hudText).toMatch(/vertical ×18/);
    expect(engaged.hudText).toMatch(/km \(real\)/);
    // Ascend back out: exaggeration disengages and the HUD line goes away.
    await page.evaluate(() => window.rcGlobe.setView('earth', { instant: true }));
    await page.waitForTimeout(600);
    const out = await page.evaluate(() => ({
        exag: window.rcGlobe.descentState().exag,
        hudHidden: document.getElementById('rc-descent').hidden,
    }));
    expect(out.exag).toBe(1);
    expect(out.hudHidden).toBe(true);

    // 7. Clean run.
    expect(shaderErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
});
