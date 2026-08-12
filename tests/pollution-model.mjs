/**
 * pollution-model.mjs — gates the pure kernel behind pollution.html and the
 * EarthView pollution layers (js/pollution-model.js).
 *
 * What is pinned and why:
 *   1. grid/sampling basics — bilinear sampling is exact on cell centers,
 *      periodic across the antimeridian, and a uniform field samples uniform
 *      (that identity is what makes uniform fields advect exactly).
 *   2. IDW — exact-ish on a sample, bounded by the sample range, and remote
 *      cells fall back to background instead of borrowing another
 *      continent's smog.
 *   3. k-means — deterministic across calls, finds two well-separated
 *      hotspot blobs, spherical centroids don't tear across the
 *      antimeridian, chooseHotspotCount lands on 2 for a 2-blob world.
 *   4. transport — uniform field + any wind stays uniform; monotone (no new
 *      maxima without sources); mass drift of a blob under solid-body zonal
 *      wind stays within a few %; deposition follows exp(−t/τ) exactly on a
 *      windless run; steady sources hold the observed field in place.
 *   5. climate — forcing sign/linearity, area-weighted global mean, ΔT.
 *
 * Run: node tests/pollution-model.mjs
 */

import {
    makeGrid, cellLat, cellLon, sampleGrid, globalMean, haversineKm,
    idwGrid, supportAt, kmeansHotspots, chooseHotspotCount, windToUV, stepTransport,
    inferSteadySources, aodFromPm25, directForcingWm2, forcingGridFromPm25,
    equilibriumDeltaT, PM25_PER_AOD, FORCING_PER_AOD_WM2,
} from '../js/pollution-model.js';

let checks = 0;
function assert(cond, msg) {
    checks++;
    if (!cond) {
        console.error(`  ✗ ${msg}`);
        process.exitCode = 1;
        return false;
    }
    return true;
}
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b}±${tol})`);

// ── 1. Grid + sampling ──────────────────────────────────────────────────────
{
    const g = makeGrid(72, 36);
    g.data[10 * 72 + 20] = 7;
    near(sampleGrid(g, cellLat(10, 36), cellLon(20, 72)), 7, 1e-6, 'bilinear exact on a cell center');

    const u = makeGrid(72, 36, 3.5);
    near(sampleGrid(u, 41.3, 179.9), 3.5, 1e-6, 'uniform field samples uniform across the antimeridian');
    near(sampleGrid(u, -89.9, 12), 3.5, 1e-6, 'uniform field samples uniform at the pole clamp');
    near(globalMean(u), 3.5, 1e-6, 'global mean of a uniform field is the value');

    // Area weighting: put mass only in the polar row vs the equator row of
    // an otherwise-zero grid — the equatorial mass must dominate the mean.
    const polar = makeGrid(72, 36); polar.data.fill(1, 0, 72);
    const equat = makeGrid(72, 36); equat.data.fill(1, 17 * 72, 18 * 72);
    assert(globalMean(equat) > 5 * globalMean(polar), 'global mean is cos-lat area weighted');
}

// ── 2. IDW ─────────────────────────────────────────────────────────────────
{
    const samples = [
        { lat: 28.6, lon: 77.2, value: 120 },   // Delhi-ish
        { lat: 40.7, lon: -74.0, value: 20 },   // NYC-ish
    ];
    const g = idwGrid(samples, 144, 72, { background: 4 });
    const nearDelhi = sampleGrid(g, 28.6, 77.2);
    assert(nearDelhi > 80, `IDW ≈ sample value on top of a sample (got ${nearDelhi})`);
    let max = -Infinity, min = Infinity;
    for (const v of g.data) { if (v > max) max = v; if (v < min) min = v; }
    assert(max <= 120 + 1e-3 && min >= 0, 'IDW bounded by the sample range / background');
    near(sampleGrid(g, -45, -140), 4, 0.5, 'remote South-Pacific cell falls back to background');
    const empty = idwGrid([], 12, 6, { background: 2 });
    near(empty.data[0], 2, 1e-9, 'no samples → pure background field');
}

// ── 3. k-means hotspots ────────────────────────────────────────────────────
{
    // Two blobs: a heavy South-Asia cluster and a light US-east cluster.
    const pts = [
        { lat: 28.6, lon: 77.2, weight: 160, value: 160 },
        { lat: 26.8, lon: 80.9, weight: 140, value: 140 },
        { lat: 23.8, lon: 90.4, weight: 150, value: 150 },
        { lat: 40.7, lon: -74.0, weight: 30, value: 30 },
        { lat: 39.9, lon: -75.2, weight: 25, value: 25 },
        { lat: 38.9, lon: -77.0, weight: 28, value: 28 },
    ];
    const a = kmeansHotspots(pts, { k: 2 });
    const b = kmeansHotspots(pts, { k: 2 });
    assert(JSON.stringify(a) === JSON.stringify(b), 'k-means is deterministic across calls');
    assert(a.length === 2, 'two clusters returned');
    assert(a[0].totalWeight > a[1].totalWeight, 'clusters sorted by total weight');
    assert(haversineKm(a[0].lat, a[0].lon, 26.5, 82.5) < 900, `heavy cluster lands in South Asia (${a[0].lat.toFixed(1)}, ${a[0].lon.toFixed(1)})`);
    assert(haversineKm(a[1].lat, a[1].lon, 39.8, -75.4) < 500, `light cluster lands on the US east coast (${a[1].lat.toFixed(1)}, ${a[1].lon.toFixed(1)})`);
    assert(a[0].meanValue > 100 && a[1].meanValue < 40, 'cluster mean values reflect their members');
    assert(a[0].members.length === 3 && a[1].members.length === 3, 'membership partition is 3+3');

    // Antimeridian: a blob straddling ±180 must centroid near 180, not 0.
    const wrap = kmeansHotspots([
        { lat: 60, lon: 179.5, weight: 10 },
        { lat: 60, lon: -179.5, weight: 10 },
    ], { k: 1 });
    assert(Math.abs(Math.abs(wrap[0].lon) - 180) < 1, `spherical centroid respects the antimeridian (lon ${wrap[0].lon.toFixed(1)})`);

    near(chooseHotspotCount(pts, { kMax: 5 }), 2, 0, 'elbow picks k=2 for a 2-blob world');
    assert(kmeansHotspots([], { k: 3 }).length === 0, 'empty input → no clusters');
    assert(kmeansHotspots([{ lat: 0, lon: 0, weight: 0 }], { k: 2 }).length === 0, 'zero-weight rows dropped');
}

// ── 4. Transport ───────────────────────────────────────────────────────────
{
    const W = 72, H = 36, N = W * H;
    const zonal = { u: new Float32Array(N).fill(10), v: new Float32Array(N) };

    // Uniform stays uniform under any wind, no sinks.
    const u0 = makeGrid(W, H, 5);
    const u1 = stepTransport(u0, zonal, { dtS: 3600, lifetimeS: Infinity });
    let drift = 0;
    for (const v of u1.data) drift = Math.max(drift, Math.abs(v - 5));
    assert(drift < 1e-4, `uniform field is a fixed point of advection (max drift ${drift})`);

    // Blob advection: monotone + bounded mass drift over 24 one-hour steps.
    let blob = makeGrid(W, H);
    for (let y = 14; y <= 21; y++) for (let x = 30; x <= 37; x++) {
        blob.data[y * W + x] = 100;
    }
    const mass0 = globalMean(blob);
    const max0 = 100;
    for (let t = 0; t < 24; t++) {
        blob = stepTransport(blob, zonal, { dtS: 3600, lifetimeS: Infinity });
    }
    let max1 = 0;
    for (const v of blob.data) max1 = Math.max(max1, v);
    assert(max1 <= max0 + 1e-3, `semi-Lagrangian is monotone (max ${max1})`);
    const massDrift = Math.abs(globalMean(blob) - mass0) / mass0;
    assert(massDrift < 0.05, `mass drift under solid zonal flow < 5% (got ${(massDrift * 100).toFixed(2)}%)`);
    // The blob must actually have moved east: 10 m/s · 24 h ≈ 864 km ≈ 7.8°.
    let cx0 = 0, cw = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        cx0 += blob.data[y * W + x] * x; cw += blob.data[y * W + x];
    }
    assert(cw > 0 && cx0 / cw > 34.4, `blob advected east (centroid col ${(cx0 / cw).toFixed(2)})`);

    // Deposition: windless run decays exactly exp(−t/τ).
    const still = { u: new Float32Array(N), v: new Float32Array(N) };
    const τ = 2 * 86400;
    let dec = makeGrid(W, H, 40);
    for (let t = 0; t < 12; t++) dec = stepTransport(dec, still, { dtS: 3600, lifetimeS: τ });
    near(dec.data[0], 40 * Math.exp(-12 * 3600 / τ), 0.01, 'deposition follows exp(−t/τ)');

    // Steady sources hold the observed field: C stays put when S = C/τ.
    const obs = makeGrid(W, H, 30);
    obs.data[18 * W + 10] = 90;
    const src = inferSteadySources(obs, τ);
    let held = obs;
    for (let t = 0; t < 6; t++) {
        held = stepTransport(held, still, { dtS: 3600, lifetimeS: τ, sources: src });
    }
    let heldDrift = 0;
    for (let i = 0; i < N; i++) heldDrift = Math.max(heldDrift, Math.abs(held.data[i] - obs.data[i]));
    assert(heldDrift < 0.5, `steady sources balance deposition (max drift ${heldDrift.toFixed(3)} µg/m³)`);

    // Diffusion smooths without creating negatives or raising the max.
    const spike = makeGrid(W, H);
    spike.data[18 * W + 36] = 100;
    const dif = stepTransport(spike, still, { dtS: 3600, lifetimeS: Infinity, kappaM2S: 5e4 });
    let dmax = 0, dmin = Infinity, dneigh = 0;
    for (let i = 0; i < N; i++) { dmax = Math.max(dmax, dif.data[i]); dmin = Math.min(dmin, dif.data[i]); }
    dneigh = dif.data[18 * W + 37];
    assert(dmax < 100 && dmin >= 0 && dneigh > 0, `diffusion spreads the spike (max ${dmax.toFixed(1)}, neighbor ${dneigh.toFixed(2)})`);

    // Wind conversion: met "from north" blows toward the south (v < 0).
    const n = windToUV(10, 0);
    near(n.v, -10, 1e-9, 'wind FROM north → v southward');
    near(n.u, 0, 1e-9, 'wind FROM north → no zonal component');
    const wsw = windToUV(10, 270);
    near(wsw.u, 10, 1e-9, 'wind FROM west → u eastward');
}

// ── 5. Climate estimates ───────────────────────────────────────────────────
{
    near(aodFromPm25(PM25_PER_AOD), 1, 1e-9, 'PM2.5→AOD ratio is the disclosed constant');
    near(directForcingWm2(1), FORCING_PER_AOD_WM2, 1e-9, 'forcing per unit AOD is the disclosed constant');
    assert(directForcingWm2(0.5) < 0, 'aerosol direct forcing is negative (cooling)');
    near(directForcingWm2(0.2) * 2, directForcingWm2(0.4), 1e-9, 'forcing is linear in AOD');
    near(equilibriumDeltaT(-1.25), -1, 1e-9, 'ΔT = λ·F with λ = 0.8');
    const f = forcingGridFromPm25(makeGrid(12, 6, PM25_PER_AOD));
    near(globalMean(f), FORCING_PER_AOD_WM2, 1e-6, 'uniform PM field → uniform forcing grid');
    near(aodFromPm25(NaN), 0, 1e-9, 'NaN PM2.5 → zero AOD, not NaN');
}


// ── IDW support: how far the nearest real sample is ────────────────────────
// The field is painted continuously over the planet from ~145 scattered
// points. Without this, a cell sitting on a sample and a cell 1,800 km from
// anything render identically and read as equally measured.
{
    const samples = [
        { lat: 0, lon: 0, value: 50 },
        { lat: 40, lon: -100, value: 10 },
    ];
    const g = idwGrid(samples, 72, 36, { maxDistKm: 2000, background: 3 });

    assert(g.sampleCount === 2, 'the grid records how many samples built it');
    assert(g.maxDistKm === 2000, 'and the influence radius it used');
    assert(g.nearestKm instanceof Float32Array, 'support rides the grid');
    assert(g.nearestKm.length === 72 * 36, 'support covers every cell');

    // On top of a sample the support is within a cell or so.
    const onTop = supportAt(g, 0, 0);
    assert(onTop < 400, `on a sample the support is tight (got ${onTop.toFixed(0)} km)`);

    // Far from everything: no support, reported as Infinity rather than a
    // large finite number that could be formatted as a plausible distance.
    assert(supportAt(g, -60, 150) === Infinity,
        'a cell with nothing in range has no support');
    // ...and that cell holds the background constant, not an interpolation.
    near(sampleGrid(g, -60, 150), 3, 1e-5,
        'unsupported cells are exactly the background value');

    // Support grows monotonically along a ray away from the sample.
    let prev = -1, monotonic = true;
    for (const lat of [0, 5, 10, 15, 20]) {
        const sup = supportAt(g, lat, 0);
        if (sup < prev) monotonic = false;
        prev = sup;
    }
    assert(monotonic, 'support grows with distance from the sample');

    // Widening the radius converts unsupported cells into supported ones.
    // (-60, 150) is ~12,850 km from (0, 0), so the radius has to clear that —
    // 9,000 km does NOT, which is the correct refusal and worth stating.
    assert(supportAt(idwGrid(samples, 72, 36, { maxDistKm: 9000 }), -60, 150) === Infinity,
        '9,000 km still does not reach a sample 12,850 km away');
    const wide = idwGrid(samples, 72, 36, { maxDistKm: 20000, background: 3 });
    assert(Number.isFinite(supportAt(wide, -60, 150)),
        'a radius past the true separation does reach it');
    // supportAt snaps to a cell center (see its doc comment), so the answer
    // is the CELL's distance to the sample, not the probe point's. At 5°
    // cells that is up to ~390 km away; pin it against the cell center so
    // the quantization is documented rather than absorbed into a fat tolerance.
    near(supportAt(wide, -60, 150), haversineKm(-62.5, 152.5, 0, 0), 1,
        'reports the great-circle distance from the cell center to the sample');

    // No samples at all → nothing anywhere is supported.
    const none = idwGrid([], 12, 6, { background: 2 });
    assert(none.sampleCount === 0, 'an empty field counts no samples');
    assert([...none.nearestKm].every(v => v === Infinity),
        'an empty field claims no support anywhere');

    // supportAt is nearest-neighbour on purpose: interpolating the support
    // distance would smooth away the very gap it exists to expose.
    assert(supportAt({ w: 2, h: 1, nearestKm: null }, 0, 0) === null,
        'a grid without support data returns null, not a fake distance');
}


if (process.exitCode) {
    console.error(`pollution-model: FAILED (${checks} checks)`);
} else {
    console.log(`pollution-model: ${checks} checks passed — grids, IDW, k-means, transport, climate estimates`);
}
