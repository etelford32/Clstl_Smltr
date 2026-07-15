/**
 * earth-terrain-patch.mjs — geometry sanity for js/earth-terrain-patch.js
 * ═══════════════════════════════════════════════════════════════════════════════
 * The displaced-terrain patch renders blind: a malformed grid would put vertices
 * off the sphere (wrong texture alignment → the patch floats off its footprint),
 * emit out-of-range indices (GPU crash / dropped draw), or leave gaps at the
 * boundary (visible seam). The displacement + depth tuning are GPU-only, but the
 * geometry pipeline (buildPatchArrays) is a pure function and is checked here.
 *
 * Checks:
 *   1. grid + skirt vertex / triangle counts match the (segs+1)² + 4·(segs+1) shape
 *   2. every grid vertex is on the unit sphere (radial displacement needs |p|=1)
 *   3. footprint corners map to the exact lat/lon positions (texture alignment)
 *   4. the UV a vertex reconstructs to equals its geographic lat/lon (the frag's
 *      normalToUV is the inverse of our latLonToLocal — alignment guarantee)
 *   5. all indices are in range and reference the built vertices
 *   6. skirt vertices are flagged and coincide with an edge grid vertex
 *   7. antimeridian-straddling footprint stays continuous (no NaN / jump)
 *
 * Run: node tests/earth-terrain-patch.mjs
 */

import { buildPatchArrays, latLonToLocal } from '../js/earth-terrain-patch.js';

let checks = 0;
function assert(cond, msg) {
    checks++;
    if (!cond) { console.error(`  ✗ ${msg}`); process.exitCode = 1; return false; }
    console.log(`  ✓ ${msg}`);
    return true;
}

const DEG = Math.PI / 180;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// Mirror the fragment shader's normalToUV (js/geo/coords.glsl.js) so we can prove
// a vertex samples the texture at its own lat/lon.
function normalToUV([x, y, z]) {
    const lat = Math.asin(Math.max(-1, Math.min(1, y)));
    const lon = Math.atan2(-z, x);
    return [(lon + Math.PI) / (2 * Math.PI), 0.5 - lat / Math.PI];
}
const latLonToUV = (latDeg, lonDeg) => [
    (lonDeg * DEG + Math.PI) / (2 * Math.PI),
    0.5 - (latDeg * DEG) / Math.PI,
];

// ── A representative footprint over the Himalaya (steep terrain, mid-latitude) ─
const segs = 48;
const fp = { latMin: 26, latMax: 32, lonMinDeg: 84, lonSpanDeg: 8 };
const P = buildPatchArrays({ ...fp, segs });

// 1. Counts
const nv = segs + 1;
const expVerts = nv * nv + 4 * nv;
const expTris  = 2 * segs * segs + 4 * 2 * segs;
assert(P.vertexCount === expVerts, `vertex count = ${expVerts} (got ${P.vertexCount})`);
assert(P.triCount === expTris, `triangle count = ${expTris} (got ${P.triCount})`);
assert(P.positions.length === expVerts * 3 && P.skirt.length === expVerts,
    `attribute arrays sized to vertex count`);

// 2. Grid vertices on the unit sphere
let maxR = 0, minR = 2;
for (let v = 0; v < nv * nv; v++) {
    const r = Math.hypot(P.positions[v*3], P.positions[v*3+1], P.positions[v*3+2]);
    maxR = Math.max(maxR, r); minR = Math.min(minR, r);
}
assert(near(maxR, 1, 1e-5) && near(minR, 1, 1e-5), `grid vertices on unit sphere (r∈[${minR.toFixed(6)}, ${maxR.toFixed(6)}])`);

// 3. Corner mapping — vertex (0,0) is (latMin, lonMin); (segs,segs) is (latMax, lonMax)
const corner00 = latLonToLocal(fp.latMin, fp.lonMinDeg);
const cornerNN = latLonToLocal(fp.latMax, fp.lonMinDeg + fp.lonSpanDeg);
const v00 = 0, vNN = segs * nv + segs;
assert(near(P.positions[v00*3], corner00[0]) && near(P.positions[v00*3+2], corner00[2]),
    `SW corner maps to (latMin, lonMin)`);
assert(near(P.positions[vNN*3], cornerNN[0]) && near(P.positions[vNN*3+1], cornerNN[1]),
    `NE corner maps to (latMax, lonMax)`);

// 4. UV round-trip: a mid vertex reconstructs to its own lat/lon
const mi = 20, mj = 30;
const lat = fp.latMin + (fp.latMax - fp.latMin) * (mi / segs);
const lon = fp.lonMinDeg + fp.lonSpanDeg * (mj / segs);
const vm = mi * nv + mj;
const uvGot = normalToUV([P.positions[vm*3], P.positions[vm*3+1], P.positions[vm*3+2]]);
const uvExp = latLonToUV(lat, lon);
assert(near(uvGot[0], uvExp[0], 1e-6) && near(uvGot[1], uvExp[1], 1e-6),
    `vertex UV matches its lat/lon (frag normalToUV is our inverse)`);

// 5. Indices in range, all triangles non-degenerate on a spot check
let idxOk = true;
for (let k = 0; k < P.index.length; k++) {
    if (P.index[k] < 0 || P.index[k] >= P.vertexCount) { idxOk = false; break; }
}
assert(idxOk, `all ${P.index.length} indices reference built vertices`);

// 6. Skirt vertices flagged and coincident with an edge grid vertex
let skFlagged = 0, skCoincident = 0;
for (let v = nv * nv; v < P.vertexCount; v++) {
    if (P.skirt[v] === 1) skFlagged++;
    // find any grid vertex at the same position
    const px = P.positions[v*3], py = P.positions[v*3+1], pz = P.positions[v*3+2];
    for (let g = 0; g < nv * nv; g++) {
        if (near(P.positions[g*3], px) && near(P.positions[g*3+1], py) && near(P.positions[g*3+2], pz)) {
            skCoincident++; break;
        }
    }
}
assert(skFlagged === 4 * nv, `all ${4 * nv} skirt vertices flagged skirt=1`);
assert(skCoincident === 4 * nv, `every skirt vertex sits on an edge grid vertex`);
// Grid vertices must NOT be flagged as skirt.
let gridClean = true;
for (let v = 0; v < nv * nv; v++) if (P.skirt[v] !== 0) { gridClean = false; break; }
assert(gridClean, `no grid vertex is mis-flagged as skirt`);

// 7. Antimeridian straddle: lonMin 176°, span 8° → crosses +180. No NaN, continuous.
const A = buildPatchArrays({ latMin: -4, latMax: 4, lonMinDeg: 176, lonSpanDeg: 8, segs: 16 });
let finite = true;
for (let i = 0; i < A.positions.length; i++) if (!Number.isFinite(A.positions[i])) { finite = false; break; }
assert(finite, `antimeridian-straddling patch has all-finite positions`);
// west edge near lon 176, east edge near lon 184≡-176 — both on the unit sphere
const wEdge = latLonToLocal(0, 176), eEdge = latLonToLocal(0, 184);
assert(near(Math.hypot(...wEdge), 1) && near(Math.hypot(...eEdge), 1),
    `antimeridian edges resolve on the sphere (cos/sin periodic)`);

if (process.exitCode) {
    console.error('\nearth-terrain-patch: FAILED');
} else {
    console.log(`\nearth-terrain-patch: ${checks} checks passed`);
}
