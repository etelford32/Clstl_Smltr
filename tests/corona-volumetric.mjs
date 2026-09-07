/**
 * tests/corona-volumetric.mjs — pins js/corona-loop-density.js (Phase 3)
 *
 *   node tests/corona-volumetric.mjs
 *
 *   • a synthetic semicircular closed loop lights the voxels along its path
 *     (R channel) and nothing far from it; an open line lights G, not R
 *   • the JS trilinear read mirrors the slice-atlas layout the shader uses
 *   • normalisation is per channel at the 99th percentile (bright arcades do
 *     not zero the rest), stray lines are skipped, empty atlases are flagged
 *   • K-corona LOS integral: exact Γ constants, kCoronaLos(1) = 1, monotone,
 *     ~0.05 at 2 R☉ (Baumbach–Allen), F is 10 % of K at the limb and b⁻²·³
 *   • prints the GLSL mirror constants so a diff against coronaFS is one look
 */
import assert from 'node:assert/strict';
import {
    LOOP_DIMS, LOOP_RMAX, TOPOLOGY, META_STRIDE,
    atlasLayout, atlasPixel, shellCoords, rasterizeLoopDensity, sampleLoopDensity, atlasFromPolylines,
    losConst, kCoronaLos, fCoronaLos, kCoronaGlslConstants, F_LIMB_FRACTION,
} from '../js/corona-loop-density.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('corona-volumetric.mjs');

function semicircle(radius, lat0 = 0.2, n = 48, topology = TOPOLOGY.CLOSED) {
    // Footpoints at ±radius along x on the surface at latitude lat0, apex height = radius.
    const pts = [];
    for (let i = 0; i < n; i++) {
        const a = Math.PI * i / (n - 1);
        const x = radius * Math.cos(a), up = radius * Math.sin(a);
        const base = [x, Math.sin(lat0), Math.cos(lat0)];
        const r = 1 + up;
        pts.push([base[0], base[1] * r, base[2] * r]);
    }
    return { points: pts, topology };
}

ok('layout: 256×128×32 shell → 4×8 tiles = 1024², voxel→pixel is injective', () => {
    const L = atlasLayout(LOOP_DIMS);
    assert.deepEqual([L.tilesX, L.tilesY, L.width, L.height], [4, 8, 1024, 1024]);
    const seen = new Set();
    for (let h = 0; h < 32; h += 3) for (let a = 0; a < 128; a += 13) for (let l = 0; l < 256; l += 29) {
        const [px, py] = atlasPixel(l, a, h, L);
        assert.ok(px >= 0 && px < 1024 && py >= 0 && py < 1024);
        const k = py * 1024 + px; assert.ok(!seen.has(k)); seen.add(k);
    }
});

ok('shell coordinates: √-stretched height resolves 1.5 Mm at slice 1; lon = atan(x, z); outside → null', () => {
    const c = shellCoords([0, 0, 1 + 1.5 / 696], LOOP_DIMS, LOOP_RMAX);     // 1.5 Mm up at disk centre
    assert.ok(c[2] > 0.9 && c[2] < 1.4, `1.5 Mm lands near slice 1 (${c[2].toFixed(2)})`);
    assert.ok(Math.abs(c[0] - (LOOP_DIMS.nlon / 2 - 0.5)) < 1e-9 && Math.abs(c[1] - (LOOP_DIMS.nlat / 2 - 0.5)) < 1e-9, 'disk centre is mid-grid');
    const w = shellCoords([1.2, 0, 0], LOOP_DIMS, LOOP_RMAX);                 // W90
    assert.ok(Math.abs(w[0] - (0.75 * LOOP_DIMS.nlon - 0.5)) < 1e-9, 'W90 → three-quarter longitude');
    assert.equal(shellCoords([0, 0, 0.9], LOOP_DIMS, LOOP_RMAX), null);
    assert.equal(shellCoords([0, 0, 2.6], LOOP_DIMS, LOOP_RMAX), null);
    assert.ok(Math.abs(shellCoords([0, 0, LOOP_RMAX], LOOP_DIMS, LOOP_RMAX)[2] - (LOOP_DIMS.nh - 1)) < 1e-9, 'r_max → last slice');
});

ok('a LOW arcade (apex 0.007 R☉ — the tracer\'s measured AR loops) is resolved, not lost below a voxel', () => {
    const low = semicircle(0.007, 0.26, 48);
    const rast = rasterizeLoopDensity(atlasFromPolylines([low]));
    const [c] = sampleLoopDensity(rast, low.points[24]);
    assert.ok(c > 0.3, `low loop apex density ${c.toFixed(3)}`);
    const [above] = sampleLoopDensity(rast, [low.points[24][0], low.points[24][1] * 1.05, low.points[24][2] * 1.05]);
    assert.ok(above < 0.05, `0.05 R☉ above the loop is dark (${above.toFixed(3)})`);
});

ok('a closed loop lights R along its path and stays dark 0.5 R☉ away; an open line lights G only', () => {
    const loop = semicircle(0.35);
    const open = { points: Array.from({ length: 48 }, (_, i) => [0, -1 - i * 0.03, 0]), topology: TOPOLOGY.OPEN_NEG };
    const rast = rasterizeLoopDensity(atlasFromPolylines([loop, open]));
    assert.equal(rast.empty, false);
    assert.equal(rast.stats.closed, 1); assert.equal(rast.stats.open, 1);
    // Apex of the loop: strong closed density, zero open.
    const apex = loop.points[24];
    const [c, o] = sampleLoopDensity(rast, apex);
    assert.ok(c > 0.3, `apex closed density ${c.toFixed(3)}`);
    assert.equal(o, 0);
    // Half a solar radius off the loop, same height: dark.
    const far = [-apex[0], apex[1], apex[2]].map((v, i) => i === 0 ? v - 0.6 : v);
    assert.ok(sampleLoopDensity(rast, far)[0] < 0.02);
    // Along the open line: G lit, R dark.
    const [c2, o2] = sampleLoopDensity(rast, [0, -1.6, 0]);
    assert.ok(o2 > 0.3 && c2 === 0, `open line: closed ${c2}, open ${o2.toFixed(3)}`);
});

ok('per-channel 99th-percentile normalisation: a dense arcade does not zero a faint loop', () => {
    const dense = Array.from({ length: 20 }, (_, i) => semicircle(0.30 + i * 0.001));   // 20 nearly coincident loops
    const faint = semicircle(0.9, 1.0);                                                   // one polar loop
    const rast = rasterizeLoopDensity(atlasFromPolylines([...dense, faint]));
    const [f] = sampleLoopDensity(rast, faint.points[24]);
    assert.ok(f > 0.05, `faint loop survives normalisation (${f.toFixed(3)})`);
    const [d] = sampleLoopDensity(rast, dense[0].points[24]);
    assert.ok(d >= f, 'dense arcade is at least as bright');
});

ok('stray lines are skipped; an empty or missing atlas yields an empty, all-zero volume', () => {
    const stray = semicircle(0.3, 0, 48, TOPOLOGY.STRAY);
    const r1 = rasterizeLoopDensity(atlasFromPolylines([stray]));
    assert.equal(r1.stats.stray, 1); assert.equal(r1.empty, true);
    assert.ok(r1.data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 0)));
    const r2 = rasterizeLoopDensity(null);
    assert.equal(r2.empty, true); assert.deepEqual(r2.dims, LOOP_DIMS); assert.equal(r2.rMax, LOOP_RMAX);
});

ok('points outside the volume are ignored (no wrap, no throw)', () => {
    const outside = { points: Array.from({ length: 8 }, (_, i) => [3.0 + i, 0, 0]), topology: TOPOLOGY.CLOSED };
    const rast = rasterizeLoopDensity(atlasFromPolylines([outside]));
    assert.equal(rast.stats.splats, 0);
    assert.deepEqual(sampleLoopDensity(rast, [4, 0, 0]), [0, 0]);
});

ok('LOS constants √π Γ((k−1)/2)/Γ(k/2): 5.2441 (k=1.5), 1.1781 (6), 0.6581 (16)', () => {
    assert.ok(Math.abs(losConst(1.5) - 5.2441) < 1e-3);
    assert.ok(Math.abs(losConst(6) - 1.1781) < 1e-3);
    assert.ok(Math.abs(losConst(16) - 0.6581) < 1e-3);
    assert.ok(Math.abs(losConst(2) - Math.PI) < 1e-9, 'k=2 → π exactly');
});

ok('K-corona: 1 at the limb, monotone decreasing, ≈0.048 at 2 R☉, ≈0.035 at 2.5 R☉', () => {
    assert.equal(kCoronaLos(1), 1);
    let prev = 1;
    for (let b = 1.05; b <= 3; b += 0.05) { const k = kCoronaLos(b); assert.ok(k < prev, `monotone at ${b}`); prev = k; }
    assert.ok(Math.abs(kCoronaLos(2) - 0.048) < 0.003);
    assert.ok(Math.abs(kCoronaLos(2.5) - 0.035) < 0.003);
    assert.equal(kCoronaLos(0.5), 1, 'inside the disk clamps to the limb value');
    assert.equal(kCoronaLos(0), 0);
});

ok('F-corona: 10 % of K at the limb, b⁻²·³', () => {
    assert.equal(fCoronaLos(1), F_LIMB_FRACTION);
    assert.ok(Math.abs(fCoronaLos(2) - 0.1 * Math.pow(2, -2.3)) < 1e-12);
    assert.ok(fCoronaLos(2) < kCoronaLos(2), 'K still dominates at 2 R☉');
});

const g = kCoronaGlslConstants();
console.log('  GLSL mirror (coronaFS): K = ' + g.terms.map(([c, e]) => `${c.toFixed(5)}·b^${e}`).join(' + ') + `; F = ${g.fLimb}·b^${g.fExp}`);
console.log(`\n${passed} checks passed`);
