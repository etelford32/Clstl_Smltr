#!/usr/bin/env node
/**
 * cloud-mosaic-core.mjs
 *
 * Pure-Node smoke test for js/cloud-mosaic-core.js — the pixel math behind
 * the GIBS cloud mosaic (normalization, disc feathering, two-tier weighted
 * compositing, coverage analysis, snapshot TIME candidates).
 *
 * The regressions locked in here are exactly the ones that produced the
 * "vertical line of clouds" artifact on earth.html:
 *   1. Product decode: IR bright=cloud, GeoColor deserts NOT cloud,
 *      COT-transparent = observed-clear (never "unobserved").
 *   2. Disc feather: full weight at nadir, smooth C0 fade, zero past 76°,
 *      antimeridian wrap for the Himawari disc.
 *   3. Compositing: overlapping discs blend without a hard step; stale
 *      fill never dilutes fresh primary data; disc gaps stay honest.
 *   4. Gap finder: a synthetic uncovered lune is located and measured.
 *   5. TIME candidates: freshest-first real timestamps, date-only tail.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';

const {
    productKind, cloudinessFromPixel, discWeight,
    MosaicAccumulator, widestLowArc, gibsTimeCandidates, toUtcDate,
    cloudTopHeightKm, IR_BT_WARM_K, IR_BT_COLD_K,
} = await import('../js/cloud-mosaic-core.js');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}

const px = [0, 0];

// ── 1. Product classification ───────────────────────────────────────────────
check('productKind classifies the live layer chains', () => {
    assert.equal(productKind('GOES-East_ABI_GeoColor'), 'geocolor');
    assert.equal(productKind('GOES-East_ABI_Band13_Clean_Infrared_Brightness_Temperature'), 'ir');
    assert.equal(productKind('Meteosat-11_IODC_Brightness_Temperature_Band_13_4'), 'ir');
    assert.equal(productKind('MODIS_Terra_Cloud_Optical_Thickness'), 'cot');
    assert.equal(productKind('MODIS_Terra_CorrectedReflectance_TrueColor'), 'truecolor');
    assert.equal(productKind('Some_Future_Layer'), 'truecolor'); // conservative default
});

// ── 2. Per-pixel decode ──────────────────────────────────────────────────────
check('IR: bright (cold) = cloud, dark (warm surface) = clear', () => {
    cloudinessFromPixel(235, 235, 235, 255, 'ir', px);
    assert.ok(px[0] > 0.9, `deep convection should read ~1, got ${px[0]}`);
    assert.equal(px[1], 1, 'opaque IR pixel = full confidence');
    cloudinessFromPixel(45, 45, 45, 255, 'ir', px);
    assert.equal(px[0], 0, 'warm surface should read 0 cloud');
    assert.equal(px[1], 1, 'clear-sky IR is still a confident observation');
});

check('GeoColor: white cloud reads high, Sahara tan reads low', () => {
    cloudinessFromPixel(240, 242, 245, 255, 'geocolor', px);
    const cloud = px[0];
    cloudinessFromPixel(210, 180, 140, 255, 'geocolor', px);   // desert tan
    const desert = px[0];
    assert.ok(cloud > 0.85, `white cloud should read >0.85, got ${cloud}`);
    assert.ok(desert < 0.45, `desert should read <0.45, got ${desert}`);
    assert.ok(cloud > 2 * desert, 'cloud must clearly dominate desert');
});

check('COT: transparent = observed CLEAR at reduced confidence (the wedge fix)', () => {
    cloudinessFromPixel(0, 0, 0, 0, 'cot', px);
    assert.equal(px[0], 0, 'no retrieval decodes as clear');
    assert.ok(px[1] > 0.3 && px[1] < 0.6,
        `no-retrieval confidence should be moderate (got ${px[1]}) — 0 would ` +
        'hand clear skies back to the procedural cloud generator');
    cloudinessFromPixel(200, 200, 200, 255, 'cot', px);
    assert.ok(px[0] > 0.8, 'thick retrieval reads cloudy');
});

check('non-COT transparent pixels are genuinely unobserved (conf 0)', () => {
    cloudinessFromPixel(0, 0, 0, 0, 'ir', px);
    assert.equal(px[1], 0);
    cloudinessFromPixel(0, 0, 0, 0, 'geocolor', px);
    assert.equal(px[1], 0);
});

// ── 3. Disc feather ─────────────────────────────────────────────────────────
check('discWeight: 1 at nadir, 0 past the limb, smooth in between', () => {
    assert.equal(discWeight(1, 0), 1, 'sub-satellite point');
    assert.equal(discWeight(1, 80), 0, '80° off-nadir is past the feather');
    const mid = discWeight(1, 68);
    assert.ok(mid > 0.05 && mid < 0.95, `feather band should be partial, got ${mid}`);
    // Monotone decrease across the feather band — no ripples that would
    // re-introduce rings at the disc edge.
    let prev = 1.01;
    for (let d = 55; d <= 78; d += 1) {
        const w = discWeight(1, d);
        assert.ok(w <= prev + 1e-9, `weight must not increase (${d}°)`);
        prev = w;
    }
});

check('discWeight uses great-circle angle (latitude tightens the disc)', () => {
    const eq  = discWeight(Math.cos(0), 55);
    const hi  = discWeight(Math.cos(65 * Math.PI / 180), 55);
    assert.ok(eq > hi, 'same Δlon must weigh less at 65° latitude than at the equator');
});

// ── 4. Compositor ───────────────────────────────────────────────────────────
// Tiny 36×18 globe (10°/px). Helper paints a full-frame product.
const W = 36, H = 18;
function flatImage(r, g, b, a) {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) { d[i*4] = r; d[i*4+1] = g; d[i*4+2] = b; d[i*4+3] = a; }
    return d;
}
const colOfLon = lon => Math.min(W - 1, Math.floor(((lon + 180) / 360) * W));
const rowOfLat = lat => Math.min(H - 1, Math.floor(((90 - lat) / 180) * H));
const alphaAt = (out, lon, lat) => out.data[(rowOfLat(lat) * W + colOfLon(lon)) * 4 + 3];
const grayAt  = (out, lon, lat) => out.data[(rowOfLat(lat) * W + colOfLon(lon)) * 4];

check('two overlapping discs blend without a hard confidence step', () => {
    const acc = new MosaicAccumulator(W, H);
    const img = flatImage(235, 235, 235, 255);          // overcast IR
    acc.addRegion(img, 'ir', -75, 'primary');
    acc.addRegion(img, 'ir', 0, 'primary');
    const out = acc.finalize();
    // Scan the equator row between the two sub-satellite points: alpha must
    // never jump more than the feather's per-10°-pixel slope allows. The old
    // source-over compositor jumped 255 → 0 in one pixel at the disc edge.
    const j = rowOfLat(0);
    let maxStep = 0;
    for (let i = colOfLon(-75); i < colOfLon(0); i++) {
        const a0 = out.data[(j * W + i) * 4 + 3];
        const a1 = out.data[(j * W + i + 1) * 4 + 3];
        maxStep = Math.max(maxStep, Math.abs(a1 - a0));
    }
    assert.ok(maxStep < 200, `confidence step between discs too hard: ${maxStep}/255`);
    assert.equal(alphaAt(out, -75, 0), 255, 'nadir fully confident');
});

check('fresh primary data is not diluted by stale fill (two-tier rule)', () => {
    const acc = new MosaicAccumulator(W, H);
    acc.addRegion(flatImage(235, 235, 235, 255), 'ir', 0, 'primary');   // overcast disc
    acc.addRegion(flatImage(0, 0, 0, 0), 'cot', null, 'fill');          // MODIS says clear everywhere
    const out = acc.finalize();
    const atNadir = grayAt(out, 0, 0);
    assert.ok(atNadir > 230,
        `disc nadir must stay overcast despite clear fill underneath, got ${atNadir}/255`);
    // Far outside the disc the fill's observed-clear should rule.
    assert.ok(grayAt(out, 180, 0) < 10, 'antipode reads clear from fill');
    const antipodeConf = alphaAt(out, 180, 0);
    assert.ok(antipodeConf > 60 && antipodeConf < 200,
        `antipode confidence should be the fill's moderate value, got ${antipodeConf}`);
});

check('Himawari-style disc wraps the antimeridian', () => {
    const acc = new MosaicAccumulator(W, H);
    acc.addRegion(flatImage(235, 235, 235, 255), 'ir', 140.7, 'primary');
    const out = acc.finalize();
    assert.ok(alphaAt(out, -170, 0) > 200,
        'a 140.7°E disc must still be confident at 170°W (49° away through the antimeridian)');
    assert.equal(alphaAt(out, -40, 0), 0, 'the far side of the globe is unobserved');
});

check('coverage stats + gap finder locate an uncovered lune', () => {
    const acc = new MosaicAccumulator(W, H);
    // Discs at -137, -75 and 141 — the Meteosat sector (~0–60°E) left dark,
    // simulating the layer-ID-rot failure that painted the original wedge.
    const img = flatImage(235, 235, 235, 255);
    for (const subLon of [-137, -75, 141]) acc.addRegion(img, 'ir', subLon, 'primary');
    const { stats } = acc.finalize();
    assert.ok(stats.coverage > 0.4 && stats.coverage < 0.98,
        `partial coverage expected, got ${stats.coverage}`);
    assert.ok(stats.gapMaxDeg >= 20, `should report a wide gap, got ${stats.gapMaxDeg}°`);
    assert.ok(stats.gapCenterLon > 0 && stats.gapCenterLon < 90,
        `gap centre should fall in the missing Meteosat sector, got ${stats.gapCenterLon}°`);
});

// ── 4b. Cloud-top height channel (Phase 2.3) ────────────────────────────────
const blueAt = (out, lon, lat) => out.data[(rowOfLat(lat) * W + colOfLon(lon)) * 4 + 2];

check('IR discs write top-coldness into B; non-IR products leave B at 0', () => {
    const acc = new MosaicAccumulator(W, H);
    acc.addRegion(flatImage(235, 235, 235, 255), 'ir', 0, 'primary');       // cold tops
    const out = acc.finalize();
    // lum 235/255 ≈ 0.922 → coldness = (0.922 − 0.30)/(0.82 − 0.30) clamps to 1.
    assert.equal(blueAt(out, 0, 0), 255, 'deep-cold IR top reads coldness 1');
    assert.equal(blueAt(out, -110, 0), 0, 'outside the disc: no IR estimate');

    const geo = new MosaicAccumulator(W, H);
    geo.addRegion(flatImage(240, 242, 245, 255), 'geocolor', 0, 'primary'); // bright RGB cloud
    const outGeo = geo.finalize();
    assert.equal(blueAt(outGeo, 0, 0), 0, 'GeoColor carries no BT signal');
    assert.ok(outGeo.data[(rowOfLat(0) * W + colOfLon(0)) * 4] > 200,
        'GeoColor cloudiness (R) still composites normally');
});

check('warm-top IR (low deck) reads low coldness; overlapping discs blend B', () => {
    const acc = new MosaicAccumulator(W, H);
    // lum 120/255 ≈ 0.471 → coldness ≈ (0.471 − 0.30)/0.52 ≈ 0.328
    acc.addRegion(flatImage(120, 120, 120, 255), 'ir', -75, 'primary');
    acc.addRegion(flatImage(235, 235, 235, 255), 'ir', 0, 'primary');
    const out = acc.finalize();
    const warmOnly = blueAt(out, -110, 0);   // deep in the −75° disc only
    const coldOnly = blueAt(out, 35, 0);     // deep in the 0° disc only
    const mid      = blueAt(out, -37, 0);    // overlap → weighted between
    assert.ok(Math.abs(warmOnly - Math.round(0.32845 * 255)) <= 2,
        `warm top ≈ 84/255, got ${warmOnly}`);
    assert.equal(coldOnly, 255);
    assert.ok(mid > warmOnly && mid < coldOnly,
        `overlap must blend between the discs, got ${mid}`);
});

check('cloudTopHeightKm decodes the coldness axis against a 2 m reference', () => {
    // coldness 1 → BT 195 K = −78.15 °C. T2m 25 °C → (25 + 78.15)/6.5 ≈ 15.87 km.
    const deep = cloudTopHeightKm(1, 25);
    assert.ok(Math.abs(deep - (25 - (IR_BT_COLD_K - 273.15)) / 6.5) < 1e-9);
    assert.ok(deep > 15 && deep < 16.5, `deep convection ≈ 15.9 km, got ${deep}`);
    // coldness 0 → no estimate (accumulator writes 0 for "no IR").
    assert.equal(cloudTopHeightKm(0, 25), null);
    assert.equal(cloudTopHeightKm(0.5, NaN), null);
    // Warm shallow top over a cold surface clamps at 0, never negative.
    assert.equal(cloudTopHeightKm(0.05, -40), 0);
    // Constants sanity — the CLOUD_FRAG ramp (26.85 − b·105 °C) must match.
    assert.ok(Math.abs((IR_BT_WARM_K - 273.15) - 26.85) < 1e-9);
    assert.equal(IR_BT_WARM_K - IR_BT_COLD_K, 105);
});

check('widestLowArc handles wrap-around and all-covered/all-gap edges', () => {
    assert.equal(widestLowArc([1, 1, 1, 1], 0.3).lenBands, 0);
    assert.equal(widestLowArc([0, 0, 0, 0], 0.3).lenBands, 4);
    const r = widestLowArc([0.1, 1, 1, 1, 1, 1, 0.1, 0.1], 0.3);   // wraps 6,7,0
    assert.equal(r.lenBands, 3);
    assert.equal(r.center, 7);
});

// ── 5. TIME candidates ──────────────────────────────────────────────────────
check('gibsTimeCandidates: freshest-first timestamps, date-only tail', () => {
    const now = Date.UTC(2026, 6, 12, 14, 18, 33);   // 2026-07-12T14:18:33Z
    const c = gibsTimeCandidates(now);
    assert.equal(c[0].time, '2026-07-12T13:50:00Z', 'floor(now − 20 min lag) to 10-min cadence');
    assert.equal(c[1].time, '2026-07-12T13:20:00Z');
    assert.equal(c[2].time, '2026-07-12T12:20:00Z');
    assert.equal(c[3].time, '2026-07-12', 'date-only compatibility net');
    assert.equal(c[4].time, '2026-07-11');
    assert.equal(c[3].timestampMs, null);
    for (let i = 1; i < 3; i++) {
        assert.ok(c[i].timestampMs < c[i - 1].timestampMs, 'strictly older as we walk back');
    }
});

check('toUtcDate formats in UTC', () => {
    assert.equal(toUtcDate(Date.UTC(2026, 0, 2, 0, 30)), '2026-01-02');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\ncloud-mosaic-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
