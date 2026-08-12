import { test, expect } from '@playwright/test';

/**
 * Console-error filter.
 *
 * The page's own errors must fail this suite — that is the point of collecting
 * them. But two entries are infrastructure, not Mars code, and neither is
 * something mars.html can fix:
 *
 *   fonts.googleapis.com   unreachable in sandboxed/offline CI. The page loads
 *                          it non-render-blocking precisely so this cannot
 *                          affect behaviour, only glyphs.
 *   /api/telemetry/log     not implemented by dev-server.mjs (it exists in the
 *                          Vercel surface). Fire-and-forget; nothing reads it.
 *
 * Anything else — including a failed /api/mars/* call that is NOT deliberately
 * routed by a test — still fails. `pageerror` is never filtered.
 */
const IGNORED_CONSOLE_ERRORS = [
    /fonts\.googleapis\.com/,
    /\/api\/telemetry\//,
];

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ consoleErrors?: boolean }} [options]
 *   consoleErrors:false for the offline test, which ABORTS most of its requests
 *   on purpose — every one of those is a resource-load console error, so
 *   collecting them there would only assert that the test did what it meant to.
 *   Uncaught exceptions are still collected in every case; those are never
 *   expected, offline or not.
 */
function collectPageErrors(page, { consoleErrors = true } = {}) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (!consoleErrors) return errors;
    page.on('console', message => {
        if (message.type() !== 'error') return;
        const text = message.text();
        const location = message.location?.()?.url || '';
        if (IGNORED_CONSOLE_ERRORS.some(pattern => pattern.test(text) || pattern.test(location))) return;
        errors.push(text);
    });
    return errors;
}

const weatherPayload = {
    ls_deg: 168.4,
    message: 'Ls 168° · clear skies · τ < 0.4',
    mission: {
        perseverance: {
            status: 'operational',
            latest_drive: { sol: 1940, distance_km: 44.14, checked_at: '2026-08-05' },
            position: { sol: 1726, lat_deg: 18.427755, lon_deg: 77.235291 },
            meda_archive: { latest_verified_sol: 1726 },
        },
    },
    rovers: {
        perseverance: {
            active: true,
            sol: 1133,
            terrestrial_date: '2024-04-27',
            min_temp_C: -79.3,
            max_temp_C: -24.7,
            pressure_pa: 778.9,
            wind_speed_mps: null,
            ls_deg: 249,
            season: 'Month 9',
            observation_status: 'historical',
            observation_age_days: 830,
            source: 'NASA Mars 2020 MEDA via mars.nasa.gov',
        },
    },
};

// Live JPL Horizons geometry served by /api/mars/ephemeris. The values are a
// coherent snapshot, not placeholders: 1.5823 AU really is 789 s of one-way
// light time, and sub_solar is already converted to the repo's planetocentric
// east-positive frame the way api/mars/ephemeris.js hands it over.
const ephemerisPayload = {
    source: 'jpl-horizons',
    jd: 2461262.5,
    ls_deg: 168.43,
    season: 'northern summer · southern winter',
    sub_solar: { lat_deg: 14.4, lon_deg: 161.23, frame: 'planetocentric · east-positive' },
    sub_earth: { lat_deg: 12.2, lon_deg: 146.54 },
    earth_range_au: 1.5823,
    earth_range_km: 236_713_000,
    light_time_s: 789.5,
    light_time_text: '13 m 09 s',
    solar_elongation_deg: 78.9,
    solar_conjunction: { state: 'clear', note: 'clear Earth–Mars line of sight' },
    ls_model_delta_deg: -7.4,
};

const skyRows = {
    '10':  [100.8, -5.2, 1.486, 2.0],
    '399': [78.9, -26.7, 1.978, -7.6],
    '301': [78.8, -26.8, 1.980, -7.5],
    '1;':  [212.4, 31.2, 2.214, 8.1],
    '4;':  [301.7, 12.8, 3.441, -3.4],
};

function horizonsObserverResult(command) {
    const [azimuth, elevation, range, rate] = skyRows[command];
    return `$$SOE
 2026-Aug-05 20:00:00.000, , , ${azimuth}, ${elevation}, ${range}, ${rate},
 2026-Aug-05 21:00:00.000, , , ${azimuth + 10}, ${elevation + 5}, ${range + 0.001}, ${rate + 0.1},
$$EOE`;
}

test('Real-Time Mars boots, preserves provenance, and exposes working layers', async ({ page }) => {
    // This walks the whole surface: boot, provenance, live geometry, both
    // camera modes, the regional terrain, drags, and a sweep of every layer
    // toggle. On a headless software rasteriser (CI, and the SwiftShader
    // fallback generally) the canvas runs at single-digit fps, so the round
    // trips add up past the 60 s default. Splitting it would lose the ordering
    // — several assertions depend on state the earlier steps set up.
    test.slow();
    const errors = collectPageErrors(page);
    await page.route('**/api/mars/weather', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(weatherPayload),
    }));
    await page.route('**/api/mars/ephemeris', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ephemerisPayload),
    }));
    // MMGIS reports no live route, so the page must fall back to the bundled
    // snapshot AND keep saying "bundled" rather than quietly implying live.
    await page.route('**/api/mars/route', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ live: false, reason: 'MMGIS HTTP 503' }),
    }));
    await page.route('**/api/horizons?**', route => {
        const command = new URL(route.request().url()).searchParams.get('COMMAND').replaceAll("'", '');
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ result: horizonsObserverResult(command) }),
        });
    });

    await page.goto('/mars.html');
    await expect(page.locator('#loading-screen')).toHaveClass(/done/, { timeout: 20_000 });
    const rejectCookies = page.getByRole('button', { name: 'Reject non-essential' });
    if (await rejectCookies.isVisible()) await rejectCookies.click();
    await expect(page.locator('#mars-canvas')).toBeVisible();
    await expect(page.locator('#drive-sol')).toHaveText('Sol 1940');
    await expect(page.locator('#fix-sol')).toHaveText('Sol 1940');
    await expect(page.locator('#pds-sol')).toHaveText('Sol 1726');
    await expect(page.locator('#route-sol')).toBeEnabled();
    await expect(page.locator('#route-sol-output')).toContainText('Sol 1940');
    await expect(page.locator('#feed-state')).toContainText('Historical MEDA summary');
    await expect(page.locator('#weather-warning')).toContainText('not live telemetry');
    await expect(page.locator('#weather-temp')).toHaveText('-79.3 → -24.7 °C');
    await expect(page.locator('#weather-wind')).toHaveText('—');
    await expect(page.locator('#sky-feed-title')).toContainText('live 5/5');
    await expect(page.locator('#sky-earth-status')).toContainText('Az');
    await expect(page.locator('#terminator-source')).toContainText('JPL Sun direction');

    // ── Live Mars geometry (JPL Horizons via /api/mars/ephemeris) ───────────
    await expect(page.locator('#geo-range strong')).toHaveText('236.7 M km');
    await expect(page.locator('#geo-light-time strong')).toHaveText('13 m 09 s');
    await expect(page.locator('#geo-elongation strong')).toHaveText('78.9°');
    await expect(page.locator('#geo-subsolar strong')).toHaveText('14.4°, 161.2°');
    await expect(page.locator('#geometry-note')).toContainText('live JPL Horizons');
    // The gap against the bundled mean-motion model is stated, not hidden.
    await expect(page.locator('#geometry-note')).toContainText('7.4° of Ls');
    // Season comes from JPL (168°), NOT from the weather payload's rover record
    // (249°) — a later weather refresh must not overwrite the better number.
    await expect(page.locator('#header-season')).toHaveText('LS 168°');
    await expect(page.locator('#weather-season')).toHaveText('Ls 168°');
    await expect.poll(() => page.evaluate(() => window.__marsLab.feedState())).toMatchObject({
        ephemeris: 'jpl-horizons',
        route: 'bundled',
        routeReason: 'MMGIS HTTP 503',
    });
    await expect(page.locator('#route-source')).toContainText('bundled NASA stops');

    // ── Depth range and ground anchoring ───────────────────────────────────
    // The globe used to pair near 0.00002 with far 100 (a 5,000,000:1 ratio no
    // 24-bit depth buffer can resolve) and hang every marker on a fixed radius
    // ~150 km above the terrain it labelled. Both are regressions worth a gate.
    const globalRender = await page.evaluate(() => window.__marsLab.renderState());
    expect(globalRender.depthRatio).toBeLessThan(2_000);
    expect(globalRender.starsFollowCamera).toBe(true);
    const globalAnchors = await page.evaluate(() => window.__marsLab.anchorState());
    expect(globalAnchors.markerAltitudeKm).toBeLessThan(12);
    expect(globalAnchors.markerAltitudeKm).toBeGreaterThan(0);
    expect(globalAnchors.routeAltitudeKm).toBeLessThan(12);
    expect(globalAnchors.routeAltitudeKm).toBeGreaterThan(0);
    await expect(page.locator('#camera-mode')).toHaveText('Mission orbit');
    await expect(page.locator('#camera-range')).toHaveAttribute('data-range-km', /\d+/);
    await expect.poll(() => page.evaluate(() => window.__marsLab.inputState())).toMatchObject({
        zoomToCursor: true,
        mouse: { primary: 'rotate', middle: 'dolly', secondary: 'rotate' },
        touch: { oneFinger: 'rotate', twoFinger: 'dolly-rotate', doubleTap: 'surface-target' },
    });
    const desktopControls = await page.evaluate(() => {
        const stage = document.querySelector('#mars-viewport').getBoundingClientRect();
        const dock = document.querySelector('.camera-dock').getBoundingClientRect();
        const missionPanel = document.querySelector('.mission-panel').getBoundingClientRect();
        return {
            stageLeft: stage.left,
            stageWidth: stage.width,
            dockLeft: dock.left,
            dockRight: dock.right,
            dockBottom: dock.bottom,
            missionTop: missionPanel.top,
        };
    });
    expect(desktopControls.dockLeft).toBeGreaterThanOrEqual(desktopControls.stageLeft);
    expect(desktopControls.dockRight).toBeLessThan(desktopControls.stageLeft + desktopControls.stageWidth / 3);
    expect(desktopControls.dockBottom).toBeLessThanOrEqual(desktopControls.missionTop);

    const clearCanvas = page.locator('#ui-panels-toggle');
    await expect(clearCanvas).toBeVisible();
    await clearCanvas.click();
    await expect(page.locator('.mars-app')).toHaveClass(/interface-clean/);
    await expect(clearCanvas).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.mission-panel')).toBeHidden();
    await expect(page.locator('.layers-panel')).toBeHidden();
    await expect(page.locator('.data-dock')).toBeHidden();
    await expect(page.locator('#mars-canvas')).toBeVisible();
    await clearCanvas.click();
    await expect(clearCanvas).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.mission-panel')).toBeVisible();

    const missionCollapse = page.locator('.mission-panel .panel-toggle');
    await missionCollapse.click();
    await expect(page.locator('.mission-panel')).toHaveClass(/collapsed/);
    await expect(missionCollapse).toHaveText('+');
    await missionCollapse.click();
    await expect(page.locator('.mission-panel .panel-body')).toBeVisible();

    const weatherCollapse = page.locator('#weather-collapse');
    await expect(weatherCollapse).toBeVisible();
    await weatherCollapse.click();
    await expect(page.locator('.data-dock')).toHaveClass(/collapsed/);
    await expect(weatherCollapse).toHaveText('+');
    await expect(page.locator('.weather-grid')).toBeHidden();
    await weatherCollapse.click();
    await expect(page.locator('.weather-grid')).toBeVisible();

    // ── A bare click selects; it does not seize the camera ─────────────────
    // OrbitControls fires 'start' on pointerdown, so wiring the mode switch to
    // it meant one click to inspect a landmark silently relabelled the camera
    // "Free orbit" and stopped the globe rotating.
    await expect(page.locator('#camera-mode')).toHaveText('Mission orbit');
    await expect(page.locator('#camera-spin')).toHaveAttribute('aria-pressed', 'true');
    const canvasForClick = await page.locator('#mars-canvas').boundingBox();
    await page.mouse.click(canvasForClick.x + canvasForClick.width * 0.5, canvasForClick.y + 300);
    await page.waitForTimeout(300);
    await expect(page.locator('#camera-mode')).toHaveText('Mission orbit');
    await expect(page.locator('#camera-spin')).toHaveAttribute('aria-pressed', 'true');
    // A real drag does take the camera.
    await page.mouse.move(canvasForClick.x + canvasForClick.width * 0.5, canvasForClick.y + 300);
    await page.mouse.down();
    await page.mouse.move(canvasForClick.x + canvasForClick.width * 0.5 + 70, canvasForClick.y + 270, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('#camera-mode')).toHaveText('Free orbit');
    await expect(page.locator('#camera-spin')).toHaveAttribute('aria-pressed', 'false');

    // ── Hover advertises that markers are clickable ────────────────────────
    // Nothing on this canvas used to change on hover, so the landmark atlas
    // read as decoration rather than as 18 clickable features.
    const hovered = await (async () => {
        for (let gx = 0.30; gx <= 0.72; gx += 0.012) {
            for (const gy of [0.30, 0.38, 0.46, 0.54]) {
                await page.mouse.move(canvasForClick.x + canvasForClick.width * gx, canvasForClick.y + canvasForClick.height * gy);
                await page.waitForTimeout(90);
                const state = await page.evaluate(() => window.__marsLab.hoverState());
                if (state.label) return state;
            }
        }
        return null;
    })();
    expect(hovered, 'a landmark or sky body should be hoverable somewhere over the globe').not.toBeNull();
    expect(hovered.cursor).toBe('pick');
    await expect(page.locator('#mars-canvas')).toHaveAttribute('data-hover', 'pick');
    await expect(page.locator('#camera-help')).toContainText(hovered.label);
    // The hint that explains how to drive the canvas has to be legible: it
    // shipped at .5rem, which computes to 8px.
    const helpFontPx = await page.locator('#camera-help').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(helpFontPx).toBeGreaterThanOrEqual(10);

    await page.locator('#camera-rover').click();
    await expect(page.locator('#camera-mode')).toContainText('Rover · sol 1940');

    // ── Shortcuts work when a dock button holds focus ──────────────────────
    // They were bound to the canvas, so clicking any button — including the
    // ones whose own tooltips advertise "(H)", "(R)", "(L)" — killed them.
    await expect(page.evaluate(() => document.activeElement?.id)).resolves.toBe('camera-rover');
    await page.keyboard.press('h');
    await expect(page.locator('#camera-mode')).toHaveText('Mission orbit');
    await page.keyboard.press('l');
    await expect(page.locator('#camera-mode')).toHaveText('Landing site');
    await page.locator('#camera-rover').click();
    await expect(page.locator('#camera-mode')).toContainText('Rover · sol 1940');
    await expect(page.locator('#camera-rover')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#camera-spin')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-layer="rotate"]')).not.toBeChecked();
    await expect.poll(async () => Number(await page.locator('#camera-range').getAttribute('data-range-km'))).toBeLessThan(2_000);

    const closeRange = Number(await page.locator('#camera-range').getAttribute('data-range-km'));
    await page.locator('#camera-zoom-in').click();
    await expect.poll(async () => Number(await page.locator('#camera-range').getAttribute('data-range-km'))).toBeLessThan(closeRange);

    await page.locator('#camera-surface').click();
    await expect(page.locator('#camera-mode')).toContainText('Surface · Rover');
    await expect(page.locator('#camera-surface')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#surface-explorer')).toBeVisible();
    // The HUD names the patch's REAL relief span and the exaggeration applied
    // to it, so a viewer can tell a 4 km scarp from stretched noise.
    await expect(page.locator('#surface-detail')).toContainText('520 km MOLA patch');
    await expect(page.locator('#surface-detail')).toContainText('18×');
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().active)).toBe(true);
    // The patch resolution follows the quality ladder (256² at full budget down
    // to 96² on a software rasteriser), so assert CONSISTENCY rather than a
    // fixed count — a hard-coded number would just re-break on any CI machine
    // with a different render budget.
    await expect.poll(() => page.evaluate(() => {
        const state = window.__marsLab.surfaceState();
        return state.terrainVertices === (state.terrainSegments + 1) ** 2;
    })).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().terrainVertices)).toBeGreaterThan(9_000);
    // Regional survey framing: high enough that the horizon is in the picture.
    // The old placement sat 2 km up and 6 km back, which put the horizon above
    // the top of the frame and rendered the layer as a flat orange field.
    await expect.poll(async () => Number(await page.locator('#camera-range').getAttribute('data-range-km'))).toBeLessThan(120);
    await expect.poll(async () => Number(await page.locator('#camera-range').getAttribute('data-range-km'))).toBeGreaterThan(10);
    const surfaceState = await page.evaluate(() => window.__marsLab.surfaceState());
    expect(surfaceState.skyVisible).toBe(true);
    expect(surfaceState.reliefExaggeration).toBe(18);
    // Jezero's 520 km patch carries several km of genuine MOLA relief; if this
    // collapses, the hypsometric ramp and the HUD span are both reading noise.
    expect(surfaceState.patchRelief.spanM).toBeGreaterThan(1_000);
    // WFC geology synth: on by default, seeded from the same MOLA raster, and
    // honest in the HUD about being synthesized. Shares must sum to 1 — a
    // partial grid means the collapse died mid-solve.
    expect(surfaceState.synth.active).toBe(true);
    expect(surfaceState.synth.cells).toBe(48);
    const synthShareTotal = Object.values(surfaceState.synth.shares)
        .reduce((sum, share) => sum + share, 0);
    expect(Math.abs(synthShareTotal - 1)).toBeLessThan(1e-9);
    await expect(page.locator('#surface-detail')).toContainText('WFC geology synth');
    await expect(page.locator('#surface-detail')).toContainText('synthesized');
    // Toggling the layer off restores the pre-synth provenance line and stops
    // tinting — without touching the anchor stack (relief stays on).
    await page.locator('[data-layer="synth"]').uncheck({ force: true });
    await expect.poll(() => page.evaluate(() => window.__marsLab.layerIsVisible('synth'))).toBe(false);
    await expect(page.locator('#surface-detail')).toContainText('sub-sample roughness is illustrative');
    await expect.poll(() => page.evaluate(() => window.__marsLab.layerIsVisible('relief'))).toBe(true);
    await page.locator('[data-layer="synth"]').check({ force: true });
    await expect.poll(() => page.evaluate(() => window.__marsLab.layerIsVisible('synth'))).toBe(true);
    await expect(page.locator('#surface-detail')).toContainText('WFC geology synth');

    // ── Pilot cluster + landing reticle ──
    // The instruments a landing needs: heading, AGL, true slope (from raw
    // MOLA, never the drawn geometry), sun elevation, live relief multiplier;
    // and the 2 km reticle riding the orbit target as a scale anchor.
    const pilotEntry = await page.evaluate(() => window.__marsLab.pilotState());
    expect(pilotEntry.reliefScaleNow).toBe(18);
    expect(pilotEntry.aglKm).toBeGreaterThan(5);
    expect(pilotEntry.hdgDeg).toBeGreaterThanOrEqual(0);
    expect(pilotEntry.hdgDeg).toBeLessThan(360);
    expect(pilotEntry.slopeDeg).toBeGreaterThanOrEqual(0);
    expect(pilotEntry.slopeDeg).toBeLessThan(45);
    expect(Math.abs(pilotEntry.sunElevDeg)).toBeLessThanOrEqual(90);
    expect(pilotEntry.reticle.visible).toBe(true);
    expect(pilotEntry.reticle.radiusKm).toBe(2);
    const reticleTarget = await page.evaluate(() => window.__marsLab.surfaceState().location);
    expect(Math.abs(pilotEntry.reticle.latDeg - reticleTarget.latDeg)).toBeLessThan(0.05);
    expect(Math.abs(pilotEntry.reticle.lonDeg - reticleTarget.lonDeg)).toBeLessThan(0.05);
    await expect(page.locator('#pilot-agl')).toContainText('km');
    await expect(page.locator('#pilot-relief')).toHaveText('×18');
    await expect(page.locator('#pilot-hdg')).toContainText('°');

    // ── Close-range detail cascade ──
    // Quality-gated regolith shader: strength follows the ladder's rung
    // exactly, the HUD discloses it as synthesized whenever it is on, and
    // both drop together at the minimal rung — fidelity traded, honesty kept.
    const cascadeQuality = await page.evaluate(() => window.__marsLab.renderState());
    const expectedDetail = { high: 1, medium: 1, low: 0.6, minimal: 0 }[cascadeQuality.quality];
    expect(cascadeQuality.surfaceDetail).toBe(expectedDetail);
    await page.evaluate(() => window.__marsLab.setQuality(0, { lock: true }));
    await expect.poll(() => page.evaluate(() => window.__marsLab.renderState().surfaceDetail)).toBe(1);
    await expect(page.locator('#surface-detail')).toContainText('close-range regolith synthesized');
    await page.evaluate(() => window.__marsLab.setQuality(3, { lock: true }));
    await expect.poll(() => page.evaluate(() => window.__marsLab.renderState().surfaceDetail)).toBe(0);
    await expect(page.locator('#surface-detail')).not.toContainText('close-range regolith');
    // Descend locked to LOW: cascade still on (0.6) so ramp + regolith are
    // exercised together deterministically, but at 128² segments and 0.62
    // pixel ratio — locking HIGH here timed the whole test out on the CI
    // software rasteriser.
    await page.evaluate(() => window.__marsLab.setQuality(2, { lock: true }));
    await expect.poll(() => page.evaluate(() => window.__marsLab.renderState().surfaceDetail)).toBe(0.6);
    await expect(page.locator('#surface-detail')).toContainText('close-range regolith synthesized');

    // ── True-scale-on-final ──
    // Zooming to short final ramps the 18× exaggeration down to TRUE 1×,
    // disclosed in the HUD line, the pilot cluster, and the mesh badge —
    // and zooming back out restores the survey scale for the rest of the run.
    const viewportBox = await page.locator('#mars-viewport').boundingBox();
    const viewCenter = {
        x: viewportBox.x + viewportBox.width / 2,
        y: viewportBox.y + viewportBox.height / 2,
    };
    await page.mouse.move(viewCenter.x, viewCenter.y);
    for (let i = 0; i < 26; i += 1) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(70);
    }
    await expect.poll(
        () => page.evaluate(() => window.__marsLab.pilotState().reliefScaleNow),
        { timeout: 15_000 },
    ).toBe(1);
    await expect(page.locator('#surface-detail')).toContainText('1× TRUE SCALE');
    await expect(page.locator('#pilot-relief')).toContainText('TRUE');
    await expect(page.locator('#mars-mesh-status')).toContainText('true scale');
    // The ramp rebuild keeps the synth layer live.
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().synth.active)).toBe(true);
    for (let i = 0; i < 26; i += 1) {
        await page.mouse.wheel(0, 240);
        await page.waitForTimeout(70);
    }
    await expect.poll(
        () => page.evaluate(() => window.__marsLab.pilotState().reliefScaleNow),
        { timeout: 15_000 },
    ).toBe(18);
    await expect(page.locator('#surface-detail')).toContainText('18×');
    // Hand the rest of the run back to the adaptive ladder (from the cheap rung).
    await page.evaluate(() => window.__marsLab.setQuality(2, { lock: false }));
    const surfaceRender = await page.evaluate(() => window.__marsLab.renderState());
    expect(surfaceRender.depthRatio).toBeLessThan(20_000);
    expect(surfaceRender.near).toBeGreaterThan(0.0001);
    // The analysis lamp follows the sun rather than defaulting on: the mocked
    // Horizons Sun sits just below the local horizon, so it lights up.
    const sunState = await page.evaluate(() => window.__marsLab.sunState());
    expect(sunState.elevationAtTargetDeg).toBeLessThan(3);
    await expect(page.locator('#surface-light')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#surface-grid')).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#surface-collapse').click();
    await expect(page.locator('#surface-explorer')).toHaveClass(/collapsed/);
    await expect(page.locator('#surface-collapse')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.surface-nav')).toBeHidden();
    await page.locator('#surface-collapse').click();
    await expect(page.locator('.surface-nav')).toBeVisible();

    const surfaceCameraBeforeDrag = await page.evaluate(() => window.__marsLab.camera.position.toArray());
    const surfaceCanvasBox = await page.locator('#mars-canvas').boundingBox();
    await page.mouse.move(surfaceCanvasBox.x + surfaceCanvasBox.width * 0.56, surfaceCanvasBox.y + surfaceCanvasBox.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(surfaceCanvasBox.x + surfaceCanvasBox.width * 0.65, surfaceCanvasBox.y + surfaceCanvasBox.height * 0.43, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('#camera-mode')).toHaveText('Surface traverse');
    await expect.poll(async () => page.evaluate(before => {
        const current = window.__marsLab.camera.position.toArray();
        return Math.hypot(...current.map((value, index) => value - before[index]));
    }, surfaceCameraBeforeDrag)).toBeGreaterThan(0.0001);

    const surfaceRangeBeforeWheel = Number(await page.locator('#camera-range').getAttribute('data-range-km'));
    await page.mouse.wheel(0, -350);
    await expect.poll(async () => Number(await page.locator('#camera-range').getAttribute('data-range-km'))).toBeLessThan(surfaceRangeBeforeWheel);

    // ── The surface camera cannot orbit below its own horizon ──────────────
    // OrbitControls caches its orbit axis from camera.up AT CONSTRUCTION
    // (vendored r160, OrbitControls.js:176). Surface mode sets camera.up to the
    // local radial and reasons in a local-horizon frame, so without rebuilding
    // the controls every polar limit was being applied to Mars' spin axis
    // instead — 72° off at Jezero. Dragging swung the eye underground, and the
    // clearance clamp then fought OrbitControls for the camera every frame.
    const surfaceLimits = await page.evaluate(() => window.__marsLab.surfaceLimits());
    expect(surfaceLimits.maxPolarDeg).toBeLessThan(90);
    expect(surfaceLimits.maxPolarDeg).toBeGreaterThan(45);
    const eyeAltitude = async () => Number(await page.locator('#surface-explorer').getAttribute('data-altitude-km'));
    // Comfortably clear of SURFACE_MIN_EYE_KM (2.4). Sitting AT the floor is the
    // old failure signature: the clamp had caught a camera that OrbitControls
    // had already swung underground, and it stayed pinned there.
    expect(await eyeAltitude()).toBeGreaterThan(3);
    // Drag hard toward the horizon three times; the eye must stay above ground
    // and the orbit radius must not collapse from the clamp fighting back.
    const orbitBefore = surfaceLimits.orbitRadiusKm;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await page.mouse.move(surfaceCanvasBox.x + surfaceCanvasBox.width * 0.5, surfaceCanvasBox.y + 300);
        await page.mouse.down();
        for (let step = 1; step <= 10; step += 1) {
            await page.mouse.move(surfaceCanvasBox.x + surfaceCanvasBox.width * 0.5, surfaceCanvasBox.y + 300 - 40 * step);
        }
        await page.mouse.up();
        await page.waitForTimeout(200);
    }
    expect(await eyeAltitude()).toBeGreaterThan(3);
    // The orbit radius must be untouched by rotation. It used to shrink every
    // frame the clearance clamp and OrbitControls disagreed (55.7 → 49.1 → 46.8).
    const orbitAfter = (await page.evaluate(() => window.__marsLab.surfaceLimits())).orbitRadiusKm;
    expect(Math.abs(orbitAfter - orbitBefore)).toBeLessThan(orbitBefore * 0.02);

    // ── Right-drag translates across the terrain ───────────────────────────
    // RIGHT was mapped to ROTATE, an exact duplicate of LEFT, while the context
    // menu was suppressed anyway — the button did nothing observable.
    await expect.poll(() => page.evaluate(() => window.__marsLab.inputState().mouse.secondary)).toBe('pan-surface');
    const panBefore = await page.locator('#surface-explorer').evaluate(el => ({ lat: el.dataset.lat, lon: el.dataset.lon }));
    await page.mouse.move(surfaceCanvasBox.x + surfaceCanvasBox.width * 0.5, surfaceCanvasBox.y + 300);
    await page.mouse.down({ button: 'right' });
    for (let step = 1; step <= 10; step += 1) {
        await page.mouse.move(surfaceCanvasBox.x + surfaceCanvasBox.width * 0.5 + 14 * step, surfaceCanvasBox.y + 300 + 9 * step);
    }
    await page.mouse.up({ button: 'right' });
    await expect.poll(async () => {
        const now = await page.locator('#surface-explorer').evaluate(el => ({ lat: el.dataset.lat, lon: el.dataset.lon }));
        return now.lat !== panBefore.lat || now.lon !== panBefore.lon;
    }).toBe(true);

    const surfaceCoordinatesBeforeMove = await page.locator('#surface-explorer').evaluate(element => ({
        lat: Number(element.dataset.lat),
        lon: Number(element.dataset.lon),
    }));
    await page.getByRole('button', { name: 'Move forward' }).click();
    await expect.poll(async () => page.locator('#surface-explorer').evaluate((element, before) => Math.hypot(
        Number(element.dataset.lat) - before.lat,
        Number(element.dataset.lon) - before.lon,
    ), surfaceCoordinatesBeforeMove)).toBeGreaterThan(0.01);
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().trailPoints)).toBe(2);

    await page.locator('#surface-grid').click();
    await expect(page.locator('#surface-grid')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().gridVisible)).toBe(false);
    await page.locator('#surface-grid').click();
    await expect(page.locator('#surface-grid')).toHaveAttribute('aria-pressed', 'true');

    // Escape leaves the explorer — and works from wherever focus happens to be,
    // which is the point of binding the shortcuts at document level.
    await page.locator('#surface-grid').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#surface-explorer')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().active)).toBe(false);
    // Right-drag goes back to being a second rotate once there is no ground.
    await expect.poll(() => page.evaluate(() => window.__marsLab.inputState().mouse.secondary)).toBe('rotate');

    await page.locator('#camera-global').click();
    await expect(page.locator('#surface-explorer')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().active)).toBe(false);
    // Leaving the explorer swaps the patch's 18× exaggeration back to the
    // globe's 5×; the ground-anchored layers have to come back with it.
    await expect.poll(() => page.evaluate(() => window.__marsLab.renderState().depthRatio)).toBeLessThan(2_000);
    const restoredAnchors = await page.evaluate(() => window.__marsLab.anchorState());
    expect(restoredAnchors.markerAltitudeKm).toBeLessThan(12);
    expect(restoredAnchors.markerAltitudeKm).toBeGreaterThan(0);

    await page.locator('#camera-global').click();
    await expect(page.locator('#camera-global')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(900);

    const positionBeforeDrag = await page.evaluate(() => window.__marsLab.camera.position.toArray());
    const canvasBox = await page.locator('#mars-canvas').boundingBox();
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.52, canvasBox.y + canvasBox.height * 0.52);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.64, canvasBox.y + canvasBox.height * 0.44, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('#camera-mode')).toHaveText('Free orbit');
    await expect.poll(async () => page.evaluate(before => {
        const current = window.__marsLab.camera.position.toArray();
        return Math.hypot(...current.map((value, index) => value - before[index]));
    }, positionBeforeDrag)).toBeGreaterThan(0.05);

    const rangeBeforeWheel = Number(await page.locator('#camera-range').getAttribute('data-range-km'));
    await page.mouse.wheel(0, -500);
    await expect.poll(async () => Number(await page.locator('#camera-range').getAttribute('data-range-km'))).toBeLessThan(rangeBeforeWheel);

    await page.locator('#camera-spin').click();
    await expect(page.locator('#camera-spin')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-layer="rotate"]')).toBeChecked();

    await page.getByRole('button', { name: 'Locate Earth in the Mars sky' }).click();
    await expect(page.locator('#camera-mode')).toHaveText('Earth sky');
    await expect(page.locator('#landmark-card')).toBeVisible();
    await expect(page.locator('#landmark-card-name')).toHaveText('Earth');
    await expect(page.locator('#landmark-card-focus')).toHaveText('Center sky');
    await page.locator('#landmark-card-close').click();
    await expect(page.locator('#landmark-card')).toBeHidden();

    const firstRouteSol = await page.locator('#route-sol').getAttribute('min');
    await page.locator('#route-sol').fill(firstRouteSol);
    await expect(page.locator('#route-sol-output')).toContainText(`Sol ${firstRouteSol}`);

    for (const layer of [
        'imagery', 'grid', 'atmosphere', 'rover', 'landing', 'route', 'waypoints',
        'landmark-volcano', 'landmark-fracture', 'landmark-basins', 'landmark-polar', 'rotate',
    ]) {
        const input = page.locator(`[data-layer="${layer}"]`);
        await input.uncheck({ force: true });
        await expect.poll(() => page.evaluate(name => window.__marsLab.layerIsVisible(name), layer)).toBe(false);
    }

    const relief = page.locator('[data-layer="relief"]');
    await expect(relief).toBeChecked();
    await relief.uncheck({ force: true });
    await expect(relief).not.toBeChecked();

    const terminator = page.locator('[data-layer="terminator"]');
    await expect(terminator).toBeChecked();
    await terminator.uncheck({ force: true });
    await expect(terminator).not.toBeChecked();

    const earthSky = page.locator('[data-layer="sky-earth"]');
    await expect(earthSky).toBeChecked();
    await earthSky.uncheck({ force: true });
    await expect(earthSky).not.toBeChecked();

    const layersPanel = page.locator('.layers-panel');
    await layersPanel.locator('.panel-toggle').click();
    await expect(layersPanel).toHaveClass(/collapsed/);
    await expect(layersPanel.locator('.panel-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(layersPanel.locator('.panel-toggle')).toHaveText('+');
    expect(errors).toEqual([]);
});

test('Real-Time Mars keeps a responsive 3D stage and explicit offline fallbacks', async ({ page, context }) => {
    const errors = collectPageErrors(page, { consoleErrors: false });
    await page.setViewportSize({ width: 390, height: 844 });
    // Every Mars upstream is down, including the two live adapters. Aborting
    // them is not optional: unmocked, they would reach mars.nasa.gov and
    // ssd.jpl.nasa.gov for real, and this test asserts the fully-offline UI.
    await page.route('**/api/mars/weather', route => route.abort());
    await page.route('**/api/mars/ephemeris', route => route.abort());
    await page.route('**/api/mars/route', route => route.abort());
    await page.route('**/api/horizons?**', route => route.abort());
    await page.route('**/assets/mars/**', route => route.abort());
    await page.route('**/data/mars/perseverance-route.json', route => route.abort());

    await page.goto('/mars.html');
    await expect(page.locator('#loading-screen')).toHaveClass(/done/, { timeout: 20_000 });
    await expect(page.locator('#mars-canvas')).toBeVisible();
    await expect(page.locator('#mars-render-fallback')).toBeHidden();
    await expect(page.locator('#surface-toggle')).toBeDisabled();
    await expect(page.locator('#relief-toggle')).toBeDisabled();
    await expect(page.locator('#surface-source')).toContainText('material-color fallback');
    await expect(page.locator('#relief-source')).toContainText('smooth-sphere fallback');
    await expect(page.locator('#route-sol')).toBeDisabled();
    await expect(page.locator('#waypoints-toggle')).toBeDisabled();
    await expect(page.locator('#route-source')).toContainText('markers remain');
    await expect(page.locator('#feed-state')).toContainText('Bundled MEDA snapshot');
    await expect(page.locator('#weather-temp')).toHaveText('-79.3 → -24.7 °C');
    await expect(page.locator('#weather-season')).toHaveText('Ls 249°');
    await expect(page.locator('#weather-warning')).toContainText('Shared adapter unavailable');
    // Offline geometry must SAY it is the analytic model rather than printing a
    // confident blank where the JPL numbers would be.
    await expect(page.locator('#geometry-note')).toContainText('analytic');
    await expect(page.locator('#geo-range strong')).toHaveText('—');
    await expect.poll(() => page.evaluate(() => window.__marsLab.feedState())).toMatchObject({
        ephemeris: 'unavailable',
        route: 'unavailable',
    });

    const layout = await page.evaluate(() => {
        const rect = selector => {
            const value = document.querySelector(selector).getBoundingClientRect();
            return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height };
        };
        return {
            stage: rect('#mars-viewport'),
            canvas: rect('#mars-canvas'),
            cameraDock: rect('.camera-dock'),
            header: rect('.mars-header'),
            mission: rect('.mission-panel'),
            layers: rect('.layers-panel'),
            dock: rect('.data-dock'),
            ready: window.__marsReady,
        };
    });
    expect(layout.ready).toBe(true);
    expect(layout.stage.height).toBeGreaterThanOrEqual(350);
    expect(layout.stage.height).toBeLessThanOrEqual(430);
    expect(layout.canvas.width).toBeCloseTo(layout.stage.width, 0);
    expect(layout.canvas.height).toBeCloseTo(layout.stage.height, 0);
    expect(layout.cameraDock.left).toBeGreaterThanOrEqual(layout.stage.left);
    expect(layout.cameraDock.right).toBeLessThanOrEqual(layout.stage.right);
    expect(layout.cameraDock.bottom).toBeLessThanOrEqual(layout.stage.bottom);
    expect(layout.cameraDock.top).toBeGreaterThan(layout.header.bottom);
    expect(layout.mission.top).toBeGreaterThanOrEqual(layout.stage.bottom);
    expect(layout.layers.top).toBeGreaterThanOrEqual(layout.mission.bottom);
    expect(layout.dock.top).toBeGreaterThanOrEqual(layout.layers.bottom);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    const mobileCanvas = await page.locator('#mars-canvas').boundingBox();
    const centerX = mobileCanvas.x + mobileCanvas.width * 0.5;
    const centerY = mobileCanvas.y + mobileCanvas.height * 0.5;
    const cameraBeforeTouch = await page.evaluate(() => window.__marsLab.camera.position.toArray());
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: centerX, y: centerY, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: centerX + 52, y: centerY - 38, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(before => {
        const current = window.__marsLab.camera.position.toArray();
        return Math.hypot(...current.map((value, index) => value - before[index]));
    }, cameraBeforeTouch)).toBeGreaterThan(0.01);
    await expect.poll(() => page.evaluate(() => window.__marsLab.inputState().pointerType)).toBe('touch');

    const rangeBeforePinch = await page.evaluate(() => window.__marsLab.cameraState().rangeKm);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
        { x: centerX - 24, y: centerY, id: 2 },
        { x: centerX + 24, y: centerY, id: 3 },
    ] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
        { x: centerX - 72, y: centerY, id: 2 },
        { x: centerX + 72, y: centerY, id: 3 },
    ] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(before => Math.abs(window.__marsLab.cameraState().rangeKm - before), rangeBeforePinch)).toBeGreaterThan(10);

    for (let tap = 0; tap < 2; tap += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: centerX, y: centerY, id: 10 + tap }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await expect(page.locator('#surface-explorer')).toBeVisible();
    await expect(page.locator('#camera-mode')).toContainText('selected terrain');
    await expect(page.locator('#surface-detail')).toContainText('MOLA unavailable');
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState())).toMatchObject({
        active: true,
        hasRelief: false,
        // No MOLA ⇒ no geology synth: the WFC layer refuses to invent classes
        // with nothing measured to seed them, even while its toggle stays on.
        synth: { enabled: true, active: false },
    });
    await expect.poll(() => page.evaluate(() => {
        const state = window.__marsLab.surfaceState();
        return state.terrainVertices === (state.terrainSegments + 1) ** 2;
    })).toBe(true);
    const mobileSurfaceLayout = await page.locator('#surface-explorer').evaluate(element => {
        const stage = document.querySelector('#mars-viewport').getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return { stageLeft: stage.left, stageRight: stage.right, stageBottom: stage.bottom, left: rect.left, right: rect.right, bottom: rect.bottom };
    });
    expect(mobileSurfaceLayout.left).toBeGreaterThanOrEqual(mobileSurfaceLayout.stageLeft);
    expect(mobileSurfaceLayout.right).toBeLessThanOrEqual(mobileSurfaceLayout.stageRight);
    expect(mobileSurfaceLayout.bottom).toBeLessThanOrEqual(mobileSurfaceLayout.stageBottom);
    const fallbackSurfaceStart = await page.locator('#surface-explorer').getAttribute('data-lat');
    await page.getByRole('button', { name: 'Move forward' }).click();
    await expect.poll(() => page.locator('#surface-explorer').getAttribute('data-lat')).not.toBe(fallbackSurfaceStart);
    await page.locator('#camera-global').click();
    await expect(page.locator('#surface-explorer')).toBeHidden();

    const rejectCookies = page.getByRole('button', { name: 'Reject non-essential' });
    if (await rejectCookies.isVisible()) await rejectCookies.click();
    await page.locator('#weather-collapse').click();
    await expect(page.locator('.data-dock')).toHaveClass(/collapsed/);
    await expect(page.locator('#weather-collapse')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.weather-grid')).toBeHidden();
    await page.locator('#weather-collapse').click();
    await expect(page.locator('.weather-grid')).toBeVisible();
    expect(errors).toEqual([]);
});

test('Mars UI remains interactive while the 3D engine is still starting', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.route('**/js/mars-view.js?*', route => route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: 'await new Promise(() => {});',
    }));

    await page.goto('/mars.html', { waitUntil: 'commit' });
    const app = page.locator('.mars-app');
    await expect(app).toHaveAttribute('data-ui-ready', 'true');
    await expect(app).toHaveAttribute('data-engine-state', 'loading');
    await expect(app).toHaveAttribute('aria-busy', 'true');

    const missionCollapse = page.locator('.mission-panel .panel-toggle');
    await missionCollapse.click();
    await expect(page.locator('.mission-panel')).toHaveClass(/collapsed/);
    await expect(missionCollapse).toHaveText('+');
    await missionCollapse.click();
    await expect(page.locator('.mission-panel .panel-body')).toBeVisible();

    const weatherCollapse = page.locator('#weather-collapse');
    await weatherCollapse.click();
    await expect(page.locator('.data-dock')).toHaveClass(/collapsed/);
    await expect(page.locator('.weather-grid')).toBeHidden();
    await weatherCollapse.click();
    await expect(page.locator('.weather-grid')).toBeVisible();

    // The dock clicks above scroll the page; at 720 px that can park the layer
    // switches under the sticky nav, where a force-click hits the nav's Sign Up
    // anchor instead of the checkbox. Reset scroll — the assertion is about the
    // pending-layer queue, not about clicking through the nav.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('[data-layer="grid"]').uncheck({ force: true });
    await expect(page.locator('[data-layer="grid"]')).not.toBeChecked();
    await expect(app).toHaveAttribute('data-pending-layers', 'true');

    await page.locator('#camera-rover').click();
    await expect(app).toHaveAttribute('data-pending-command', 'focus-rover');
    await expect(page.locator('#camera-help')).toContainText('command queued');

    await page.keyboard.press('p');
    await expect(app).toHaveClass(/interface-clean/);
    await expect(page.locator('#ui-panels-toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('p');
    await expect(app).not.toHaveClass(/interface-clean/);
    await expect(page.locator('#ui-panels-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
});
