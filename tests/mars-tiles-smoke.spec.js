import { test, expect } from '@playwright/test';

/**
 * Browser gate for the streamed NASA Trek imagery on mars.html.
 *
 * The tile service is MOCKED here, the same way tests/verdict-card-smoke.spec.js
 * mocks Open-Meteo: the point of this suite is the client stack — capability
 * resolution, footprint planning, stitching, the sRGB texture upload, the
 * shader rect, and the provenance line — none of which should depend on NASA
 * being reachable from CI. Whether the catalogued layer identifiers are the
 * RIGHT ones is a separate question, answered in production by
 * `/api/mars/tiles`'s own self-report (see js/mars-tiles.js's header on why
 * they are candidate lists).
 *
 * The two paths that matter both get a test:
 *   - service up   → real imagery blends, and the page says what it is showing
 *   - service down → nothing blends, and the page says THAT, naming the
 *                    bundled texture it fell back to. A dead feed must look
 *                    dead; silently showing a 15 km/px wash as if it were
 *                    mapping is the failure this whole feature exists to end.
 */

const IGNORED_CONSOLE_ERRORS = [
    /fonts\.googleapis\.com/,
    /\/api\/telemetry\//,
    // Every other Mars feed is unrouted in this suite and falls back by design;
    // this file is about the tile layer alone.
    /\/api\/mars\/(weather|route|ephemeris)/,
    /\/api\/horizons/,
    /trek\.nasa\.gov/,
];

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        const text = message.text();
        const location = message.location?.()?.url || '';
        if (IGNORED_CONSOLE_ERRORS.some(p => p.test(text) || p.test(location))) return;
        errors.push(text);
    });
    return errors;
}

/**
 * A 2×2 PNG. Tiles only have to be decodable images for the stitch, the
 * texture upload and the shader path to be exercised end to end — their
 * contents are irrelevant to everything this suite asserts.
 */
const TILE_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVQI12P8//8/AzbAxIAH'
    + 'jEqOSgIAWJgDBZJTsRcAAAAASUVORK5CYII=',
    'base64',
);

function resolvedReport(layers = ['imagery', 'thermal', 'highres', 'topo']) {
    const catalogue = {
        imagery: { id: 'Mars_Viking_MDIM21_ClrMosaic_global_232m', gsdM: 232, maxLevel: 8,
            label: 'Viking MDIM 2.1', epoch: 'Viking Orbiter, 1976–1980', global: true },
        thermal: { id: 'Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12', gsdM: 100, maxLevel: 9,
            label: 'THEMIS day IR', epoch: 'Mars Odyssey, 2002–2011', global: true },
        highres: { id: 'Mars_MRO_CTX_mosaic_global_5m', gsdM: 5, maxLevel: 13,
            label: 'CTX global mosaic', epoch: 'MRO, 2006–2022', global: false },
        topo: { id: 'Mars_MGS_MOLA_ClrShade_merge_global_463m', gsdM: 463, maxLevel: 7,
            label: 'MOLA colour relief', epoch: 'MGS, 1997–2001', global: true },
    };
    const resolved = {};
    for (const key of Object.keys(catalogue)) {
        resolved[key] = layers.includes(key)
            ? { ...catalogue[key], candidate: 0, tilePx: 256, credit: 'NASA', contentType: 'image/png' }
            : null;
    }
    const unreachable = Object.keys(catalogue).filter(k => !layers.includes(k));
    return {
        resolved,
        unreachable,
        freshness: unreachable.length ? 'stale' : 'live',
        resolved_count: layers.length,
        realtime: { map: 'archival', illumination: '/api/mars/ephemeris' },
    };
}

/**
 * Serve the capability report and every tile, direct and proxied alike. Returns
 * a counter so a test can assert tiles were actually requested rather than the
 * stack quietly no-opping into a green result.
 */
async function mockTileService(page, { layers, tileStatus = 200 } = {}) {
    const counts = { capability: 0, direct: 0, proxy: 0 };

    await page.route('**/api/mars/tiles*', async (route) => {
        const url = new URL(route.request().url());
        if (!url.searchParams.has('z')) {
            counts.capability += 1;
            await route.fulfill({ status: 200, contentType: 'application/json',
                body: JSON.stringify(resolvedReport(layers)) });
            return;
        }
        counts.proxy += 1;
        await route.fulfill({ status: tileStatus, contentType: 'image/png', body: TILE_PNG });
    });

    await page.route('**://trek.nasa.gov/**', async (route) => {
        counts.direct += 1;
        await route.fulfill({ status: tileStatus, contentType: 'image/png', body: TILE_PNG });
    });

    return counts;
}

async function bootMars(page) {
    await page.goto('/mars.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__marsLab, null, { timeout: 60_000 });
}

const tileState = (page) => page.evaluate(() => window.__marsLab.tileState());

test('Streamed Trek imagery replaces the 15 km/px base map and says what it is', async ({ page }) => {
    const errors = collectPageErrors(page);
    const counts = await mockTileService(page);
    await bootMars(page);

    // The default framing is the whole globe, where an inset is deliberately
    // NOT fetched (js/mars-tiles.js MIN_INSET_GAIN: at that range the pyramid
    // resolves no better than the texture already on the sphere). Assert that
    // honest no-op first, then go where mapping resolution actually matters.
    await expect.poll(async () => (await tileState(page)).status, { timeout: 30_000 })
        .toBe('base');
    expect(await page.locator('#tiles-source').textContent()).toMatch(/zoom in/i);

    await page.evaluate(() => window.__marsLab.enterSurfaceExplorer(18.44, 77.45, { label: 'Jezero' }));
    await expect.poll(async () => (await tileState(page)).status, { timeout: 30_000 })
        .toBe('ready');
    const state = await tileState(page);

    // THE POINT OF THE WHOLE FEATURE: what is drawn under the camera must be
    // dramatically finer than the bundled global texture the page used to show
    // everywhere. If this ever regresses to parity, the tile stack is dead
    // weight and the surface is a wash again.
    expect(state.bundledGsdM).toBeGreaterThan(14_000);
    expect(state.gsdM).toBeLessThan(state.bundledGsdM / 20);
    expect(state.tilesLoaded).toBeGreaterThan(0);
    expect(state.coverage).toBeGreaterThan(0.99);
    expect(counts.capability).toBeGreaterThan(0);
    expect(counts.direct + counts.proxy).toBeGreaterThan(0);

    // The shader must actually be blending it — a ready state with zero
    // strength or a collapsed rect would render identically to no inset at all,
    // which is precisely the silent failure worth gating.
    expect(state.strength).toBe(1);
    const [uMin, vMin, uMax, vMax] = state.rect;
    expect(uMax).toBeGreaterThan(uMin);
    expect(vMax).toBeGreaterThan(vMin);

    // Provenance: the page names the mosaic, its epoch and its resolution.
    expect(state.provenance).toBeTruthy();
    const line = await page.locator('#tiles-source').textContent();
    expect(line).toMatch(/Viking|THEMIS|CTX|MOLA/);
    expect(line).toMatch(/\d{4}/);          // the epoch — archival, and dated
    expect(line).toMatch(/m\/px|km\/px/);   // the resolution claim
    expect(errors).toEqual([]);
});

test('Landing the surface explorer streams imagery for the patch, not the camera', async ({ page }) => {
    const errors = collectPageErrors(page);
    await mockTileService(page);
    await bootMars(page);
    await page.evaluate(() => window.__marsLab.enterSurfaceExplorer(18.44, 77.45, { label: 'Jezero' }));
    await expect.poll(async () => (await tileState(page)).boundsDeg?.latMin, { timeout: 30_000 })
        .toBeLessThan(18.44);

    const state = await tileState(page);
    // The surface camera looks at the HORIZON, so its sub-camera point is not
    // the ground being rendered. Planning from it would stream imagery for
    // terrain behind the viewer; the plan must cover the patch centre instead.
    expect(state.boundsDeg.latMin).toBeLessThanOrEqual(18.44);
    expect(state.boundsDeg.latMax).toBeGreaterThanOrEqual(18.44);
    expect(state.boundsDeg.lonMin).toBeLessThanOrEqual(77.45);
    expect(state.boundsDeg.lonMax).toBeGreaterThanOrEqual(77.45);

    // The surface explorer still works with the inset live.
    const surface = await page.evaluate(() => window.__marsLab.surfaceState());
    expect(surface.active).toBe(true);
    expect(Number.isFinite(surface.location.latDeg)).toBe(true);
    expect(surface.terrainVertices).toBeGreaterThan(0);
    const pilot = await page.evaluate(() => window.__marsLab.pilotState());
    expect(Number.isFinite(pilot.aglKm)).toBe(true);
    expect(errors).toEqual([]);
});

test('A dead tile service falls back to the bundled texture and SAYS so', async ({ page }) => {
    const errors = collectPageErrors(page);
    // Nothing resolves — the state this sandbox reproduces for real, and the
    // state production will show if NASA's layer ids have moved.
    await mockTileService(page, { layers: [] });
    await bootMars(page);
    await page.evaluate(() => window.__marsLab.enterSurfaceExplorer(18.44, 77.45, { label: 'Jezero' }));

    await expect.poll(async () => (await tileState(page)).status, { timeout: 30_000 })
        .toBe('unavailable');
    const state = await tileState(page);
    expect(state.layer).toBeNull();
    // Nothing may blend. A stale rect left armed over missing imagery would
    // paint the last inset across unrelated ground.
    expect(state.strength).toBe(0);

    const line = await page.locator('#tiles-source').textContent();
    expect(line).toMatch(/unavailable/i);
    expect(line).toMatch(/bundled/i);
    expect(line).toMatch(/15 km\/px/);   // the honest number for what IS shown

    // The page itself must still work — the tile layer is additive.
    const surface = await page.evaluate(() => window.__marsLab.surfaceState());
    expect(surface.active).toBe(true);
    expect(surface.terrainVertices).toBeGreaterThan(0);
    expect(errors).toEqual([]);
});

test('Partial coverage renders and is disclosed rather than claimed as whole', async ({ page }) => {
    // Only CTX is unreachable: the realistic steady state, since its mosaic has
    // genuine holes. The page must degrade to a global layer, not go blank.
    await mockTileService(page, { layers: ['imagery', 'thermal', 'topo'] });
    await bootMars(page);
    await page.evaluate(() => window.__marsLab.enterSurfaceExplorer(18.44, 77.45, { label: 'Jezero' }));
    await expect.poll(async () => (await tileState(page)).status, { timeout: 30_000 }).toBe('ready');

    await page.evaluate(() => window.__marsLab.setTileLayer('highres'));
    await page.waitForTimeout(3000);
    const state = await tileState(page);
    expect(state.layer).not.toBe('highres');
    expect(['imagery', 'thermal', 'topo']).toContain(state.layer);
    expect(state.capability.unreachable).toContain('highres');
});

test('The imagery layer can be switched off, and the page says what remains', async ({ page }) => {
    await mockTileService(page);
    await bootMars(page);
    await page.evaluate(() => window.__marsLab.enterSurfaceExplorer(18.44, 77.45, { label: 'Jezero' }));
    await expect.poll(async () => (await tileState(page)).status, { timeout: 30_000 }).toBe('ready');

    await page.locator('#tiles-toggle').uncheck({ force: true });
    await expect.poll(async () => (await tileState(page)).strength).toBe(0);
    expect(await page.evaluate(() => window.__marsLab.layerIsVisible('tiles'))).toBe(false);
    const off = await page.locator('#tiles-source').textContent();
    expect(off).toMatch(/off/i);
    expect(off).toMatch(/15 km\/px/);

    // Back on: the cached stitch re-arms without another fetch round trip.
    await page.locator('#tiles-toggle').check({ force: true });
    await expect.poll(async () => (await tileState(page)).strength, { timeout: 15_000 }).toBe(1);
});
