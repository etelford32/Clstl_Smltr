/**
 * cloud-mosaic-e2e.spec.js — end-to-end probe of the GIBS cloud pipeline
 * on earth.html, with the GIBS snapshot endpoint stubbed by synthetic
 * imagery (this suite must pass with zero external egress).
 *
 * Verifies the full chain that produced the "line of clouds" regression:
 *   1. SatelliteFeed → fetchCloudImagery assembles a 4-region mosaic from
 *      timestamped snapshot requests (not date-only).
 *   2. The composite texture reaches the cloud shader uniforms with
 *      flipY=false (v=0 ⇔ 90°N convention — the mosaic used to render
 *      north/south MIRRORED) and linear colorSpace.
 *   3. window.__cloudDiag carries attempts / regions / composite stats,
 *      and the coverage analyzer sees no wedge-sized gap when all four
 *      discs load.
 *   4. One 'data_pipeline' telemetry event (name 'cloud_mosaic') is
 *      shipped to /api/telemetry/log per refresh.
 */
import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';

// ── Minimal PNG encoder (RGBA, no interlace) ────────────────────────────────
// Node has no canvas; 30 lines of PNG spec beat a native dependency.
function crc32(buf) {
    let c, table = crc32.table;
    if (!table) {
        table = crc32.table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c;
        }
    }
    c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgbaFn) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // colour type RGBA
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let j = 0; j < height; j++) {
        const row = j * (1 + width * 4);
        raw[row] = 0;   // filter: none
        for (let i = 0; i < width; i++) {
            const [r, g, b, a] = rgbaFn(i, j);
            const o = row + 1 + i * 4;
            raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
        }
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// Synthetic products, small (browser rescales to the requested 2048×1024):
// geostationary IR = uniformly overcast (bright, opaque); MODIS COT =
// fully transparent (clear everywhere — exercises the observed-clear rule).
const IR_PNG  = encodePng(64, 32, () => [235, 235, 235, 255]);
const COT_PNG = encodePng(64, 32, () => [0, 0, 0, 0]);

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost', '--enable-unsafe-swiftshader'],
    },
    ignoreHTTPSErrors: true,
});

test('cloud mosaic pipeline: stubbed GIBS → normalized texture + diag + telemetry', async ({ page }) => {
    const gibsRequests = [];
    await page.route('**wvs.earthdata.nasa.gov/**', async route => {
        const url = new URL(route.request().url());
        const layers = url.searchParams.get('LAYERS') ?? '';
        const time   = url.searchParams.get('TIME') ?? '';
        gibsRequests.push({ layers, time });
        const body = /Cloud_Optical_Thickness/.test(layers) ? COT_PNG : IR_PNG;
        await route.fulfill({
            status: 200,
            contentType: 'image/png',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body,
        });
    });

    const telemetryBatches = [];
    await page.route('**/api/telemetry/log', async route => {
        try { telemetryBatches.push(route.request().postDataJSON()); } catch { /* beacon blob */ }
        await route.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' });
    });

    await page.addInitScript(() => {
        // Force telemetry onto fetch(keepalive) — sendBeacon interception is
        // not reliable across Playwright versions, fetch is.
        Object.defineProperty(navigator, 'sendBeacon', { value: undefined });
        window.__satDetails = [];
        window.addEventListener('satellite-update', e => {
            const d = e.detail;
            window.__satDetails.push({
                mosaic:  d.mosaic,
                regions: d.regions,
                layers:  d.layers,
                flipY:   d.compositeTex?.flipY,
                colorSpace: d.compositeTex?.colorSpace,
                texW:    d.compositeTex?.image?.width ?? null,
                timeIso: d.time instanceof Date ? d.time.toISOString() : null,
            });
        });
    });

    await page.goto('/earth.html?debug=1', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__satDetails?.length > 0, null, { timeout: 45_000 });
    // Let the telemetry flush interval (5 s) fire at least once.
    await page.waitForTimeout(6_000);

    // ── 1. Requests: timestamped snapshots, all four regions + polar ──────
    const timestamped = gibsRequests.filter(r => r.time.includes('T'));
    expect(timestamped.length).toBeGreaterThanOrEqual(4);
    const askedLayers = gibsRequests.map(r => r.layers).join('\n');
    for (const needle of ['GOES-East', 'GOES-West', 'Himawari', 'Meteosat', 'Cloud_Optical_Thickness']) {
        expect(askedLayers).toContain(needle);
    }

    // ── 2. The event + texture the shader consumes ─────────────────────────
    const detail = await page.evaluate(() => window.__satDetails[0]);
    expect(detail.mosaic).toBe(true);
    expect(detail.regions).toEqual(['GOES-East', 'GOES-West', 'Himawari', 'Meteosat']);
    expect(detail.flipY).toBe(false);          // v=0 ⇔ 90°N — the mirror-image regression guard
    expect(detail.colorSpace).toBe('');        // NoColorSpace: channels are linear fractions
    expect(detail.texW).toBe(2048);
    // Acquisition time is a real recent timestamp, not a date-midnight.
    const ageMin = (Date.now() - Date.parse(detail.timeIso)) / 60000;
    expect(ageMin).toBeGreaterThanOrEqual(0);
    expect(ageMin).toBeLessThan(120);

    // ── 3. Diagnostics: coverage analysis sees four discs, no wedge gap ────
    const diag = await page.evaluate(() => window.__cloudDiag);
    expect(diag.mode).toBe('mosaic');
    expect(diag.regions.map(r => r.name).sort()).toEqual(['GOES-East', 'GOES-West', 'Himawari', 'Meteosat']);
    expect(diag.polar).toBeTruthy();
    expect(diag.composite.coverage).toBeGreaterThan(0.9);   // discs + observed-clear COT fill
    expect(diag.composite.gapMaxDeg).toBeLessThan(15);      // the wedge detector stays quiet
    expect(diag.attempts.every(a => a.ok)).toBe(true);

    // ── 4. Provenance line in the wx panel ─────────────────────────────────
    await expect(page.locator('#wx-sat')).toContainText('mosaic · 4/4');
    await expect(page.locator('#wx-sat')).toContainText('cov');

    // ── 5. Telemetry event shipped ─────────────────────────────────────────
    const events = telemetryBatches.flatMap(b => b?.events ?? []);
    const pipeline = events.filter(e => e.kind === 'data_pipeline' && e.metadata?.name === 'cloud_mosaic');
    expect(pipeline.length).toBeGreaterThanOrEqual(1);
    expect(pipeline[0].metadata.ok).toBe(true);
    expect(pipeline[0].metadata.mode).toBe('mosaic');
    expect(pipeline[0].metadata.coverage).toBeGreaterThan(0.9);
});

test('cloud mosaic pipeline: GIBS fully down → warning telemetry, no texture swap', async ({ page }) => {
    await page.route('**wvs.earthdata.nasa.gov/**', route => route.abort());
    const telemetryBatches = [];
    await page.route('**/api/telemetry/log', async route => {
        try { telemetryBatches.push(route.request().postDataJSON()); } catch { /* ignore */ }
        await route.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'sendBeacon', { value: undefined });
    });

    await page.goto('/earth.html?debug=1', { waitUntil: 'load' });
    // Total failure walks the whole candidate ladder (fast aborts) before
    // diag lands; poll for it rather than sleeping a fixed time.
    await page.waitForFunction(() => window.__cloudDiag != null, null, { timeout: 60_000 });
    await page.waitForTimeout(6_000);   // telemetry flush

    const diag = await page.evaluate(() => window.__cloudDiag);
    expect(diag.mode).toBe('none');
    expect(diag.attempts.length).toBeGreaterThan(0);
    expect(diag.attempts.every(a => !a.ok)).toBe(true);

    const events = telemetryBatches.flatMap(b => b?.events ?? []);
    const pipeline = events.filter(e => e.kind === 'data_pipeline' && e.metadata?.name === 'cloud_mosaic');
    expect(pipeline.length).toBeGreaterThanOrEqual(1);
    expect(pipeline[0].severity).toBe('warning');
    expect(pipeline[0].metadata.ok).toBe(false);
    expect(pipeline[0].metadata.mode).toBe('none');
});
